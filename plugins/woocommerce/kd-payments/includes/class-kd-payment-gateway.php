<?php
// path: plugins/woocommerce/kd-payments/includes/class-kd-payment-gateway.php

/**
 * The gateway WooCommerce shows at checkout, and the one call it makes.
 *
 * ## What this class does, and what it refuses to do
 *
 * It creates a **pending payment on the platform** for the order's total, records the payment's id on the order, puts
 * the order on hold and sends the customer to the order-received page. It never collects a card, never computes a fee,
 * never decides that money arrived: the platform processes, and the platform's callback (or the shop asking) is what
 * turns the order into a paid one.
 *
 * ## Two refusals worth naming
 *
 *   - **The currency.** The platform's public API is USD only (section 20), so a shop that trades in another currency does not
 *     see this gateway at all (`is_available()`), and if it is somehow reached anyway the payment is refused rather than
 *     converted. A silent conversion is a wrong amount on a real customer's card.
 *   - **The amount.** Below the platform's floor or above its ceiling, the same: refused with a sentence the customer
 *     can act on, not a charge the platform will reject.
 *
 * ## Why the order is on hold rather than pending
 *
 * `pending` in WooCommerce means "no payment attempt yet and the stock is not held". This gateway has done everything
 * it can, so `on-hold` is the honest state: stock is reduced, the customer is told the order is waiting for
 * confirmation, and the callback moves it on. A shop that never receives the callback can still move the order by hand
 * from the order screen.
 */

defined( 'ABSPATH' ) || exit;

/** The checkout gateway for the platform's own store payments. */
class KD_Payment_Gateway extends WC_Payment_Gateway {

	/** The platform's floor and ceiling, in minor units, mirrored from its payment rules. */
	const MINIMUM_AMOUNT_MINOR = 50;
	const MAXIMUM_AMOUNT_MINOR = 10000000;

	/** The one currency the public API accepts. */
	const CURRENCY = 'USD';

	/** The order meta that ties an order to its payment. */
	const PAYMENT_ID_META = '_kd_payment_id';

	/** The order meta that records the last callback applied. */
	const CALLBACK_ID_META = '_kd_last_callback_id';

	/** The order meta that records the platform's own status. */
	const PAYMENT_STATUS_META = '_kd_payment_status';

	/**
	 * The order meta that records the amount the payment was created for, in minor units.
	 *
	 * Without it the gateway cannot tell "the customer pressed the button twice" from "the order changed after the
	 * payment was made": the total is recomputed on every submit, and a second submit that finds the first payment
	 * already recorded would send the customer on to confirm an amount the order no longer has.
	 */
	const PAYMENT_AMOUNT_META = '_kd_payment_amount';

	/** Build the gateway: its id, its name and the three settings a merchant needs. */
	public function __construct() {
		$this->id                 = 'kd_payments';
		$this->method_title       = __( 'KD Payments', 'kd-payments' );
		$this->method_description = __( 'Creates a payment on the platform and confirms the order when the platform calls back.', 'kd-payments' );
		$this->has_fields         = false;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();

		$this->enabled     = $this->get_option( 'enabled', 'no' );
		$this->title       = $this->get_option( 'title', __( 'Pay by card', 'kd-payments' ) );
		$this->description = $this->get_option( 'description', '' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
	}

	/** The settings a merchant sees on WooCommerce's own payment settings screen. */
	public function init_form_fields(): void {
		$this->form_fields = array(
			'enabled'     => array(
				'title'   => __( 'Enable', 'kd-payments' ),
				'type'    => 'checkbox',
				'label'   => __( 'Show this payment method at checkout', 'kd-payments' ),
				'default' => 'no',
			),
			'title'       => array(
				'title'       => __( 'Title', 'kd-payments' ),
				'type'        => 'text',
				'description' => __( 'What the customer sees at checkout.', 'kd-payments' ),
				'default'     => __( 'Pay by card', 'kd-payments' ),
			),
			'description' => array(
				'title'   => __( 'Description', 'kd-payments' ),
				'type'    => 'textarea',
				'default' => __( 'Your payment is processed by KD Solutions.', 'kd-payments' ),
			),
		);
	}

	/**
	 * Whether the gateway may appear.
	 *
	 * Four facts, and every one of them would make a payment fail after the customer pressed the button: the setting,
	 * a saved key, an active connection and the right currency. Whether *this* order is already paid is not one of them -
	 * availability is asked before an order exists - and `process_payment()` answers that one for itself.
	 */
	public function is_available(): bool {
		if ( ! parent::is_available() ) {
			return false;
		}

		if ( '' === KD_Connection::api_key() || ! KD_Connection::is_active() ) {
			return false;
		}

		return get_woocommerce_currency() === self::CURRENCY;
	}

	/** What the customer is told on the checkout page: a sentence, because the platform collects the card. */
	public function payment_fields(): void {
		if ( '' === $this->description ) {
			return;
		}

		echo '<p>' . esc_html( $this->description ) . '</p>';
	}

	/**
	 * Create the payment for one order.
	 *
	 * @param int $order_id The order WooCommerce is checking out.
	 * @return array{result: string, redirect?: string}
	 */
	public function process_payment( $order_id ) {
		$order = wc_get_order( $order_id );

		if ( ! $order instanceof WC_Order ) {
			wc_add_notice( __( 'That order could not be found.', 'kd-payments' ), 'error' );

			return array( 'result' => 'failure' );
		}

		if ( '' === KD_Connection::api_key() || ! KD_Connection::is_active() ) {
			// The order-pay screen can reach this method without `is_available()` ever being asked, so the two facts
			// that make a payment possible are checked here as well: a missing key is a `401` a customer would read as
			// a broken shop, and a revoked or half-finished connection creates a payment whose callback nothing will
			// answer, leaving the order on hold with no way forward but the store's own order screen.
			wc_add_notice( __( 'This shop is not connected to the platform yet. Please contact the store.', 'kd-payments' ), 'error' );

			return array( 'result' => 'failure' );
		}

		if ( $order->is_paid() ) {
			// Nothing to start: the order is paid, and a second payment would be a second charge for it.
			return array(
				'result'   => 'success',
				'redirect' => $order->get_checkout_order_received_url(),
			);
		}

		$amount   = $this->amount_minor_of( $order );
		$existing = $order->get_meta( self::PAYMENT_ID_META );
		$recorded = $order->get_meta( self::PAYMENT_AMOUNT_META );

		$same_amount = ! is_string( $recorded ) || '' === $recorded || (string) $amount === $recorded;

		if ( is_string( $existing ) && '' !== $existing && $same_amount ) {
			// The customer is submitting the same order twice, for the same amount. The payment exists; do not make a
			// second one. An order whose total moved after the payment was made is *not* this case: the payment on the
			// platform is for the old amount, and confirming it would take the wrong money from the customer.
			return array(
				'result'   => 'success',
				'redirect' => $order->get_checkout_order_received_url(),
			);
		}

		if ( $amount < self::MINIMUM_AMOUNT_MINOR || $amount > self::MAXIMUM_AMOUNT_MINOR ) {
			wc_add_notice( __( 'This order total cannot be paid with this method.', 'kd-payments' ), 'error' );

			return array( 'result' => 'failure' );
		}

		$client = new KD_Api_Client( KD_Connection::api_key(), kd_payments_api_base() );
		$answer = $client->create_payment(
			$amount,
			self::CURRENCY,
			'card',
			$this->idempotency_key_of( $order, $amount )
		);

		if ( ! $answer['ok'] ) {
			wc_add_notice( $this->failure_sentence( $answer['status'] ), 'error' );

			return array( 'result' => 'failure' );
		}

		$payment_id = isset( $answer['body']['id'] ) && is_string( $answer['body']['id'] ) ? $answer['body']['id'] : '';
		$mode       = isset( $answer['body']['mode'] ) && is_string( $answer['body']['mode'] ) ? $answer['body']['mode'] : 'live';

		if ( '' === $payment_id ) {
			wc_add_notice( __( 'The platform did not answer with a payment.', 'kd-payments' ), 'error' );

			return array( 'result' => 'failure' );
		}

		if ( is_string( $existing ) && '' !== $existing && $existing !== $payment_id ) {
			// The total moved, so this is a second payment for the same order. The first one was never paid - it is
			// `pending` on the platform - and the id below replaces it, so a callback about it finds no order and the
			// platform stops retrying rather than moving an order it is not about.
			$order->add_order_note( __( 'The order total changed after a payment was created, so a new payment was made for the new total.', 'kd-payments' ) );
		}

		$order->update_meta_data( self::PAYMENT_ID_META, $payment_id );
		$order->update_meta_data( self::PAYMENT_AMOUNT_META, (string) $amount );
		$order->update_meta_data( self::PAYMENT_STATUS_META, 'pending' );
		$order->update_meta_data( '_kd_payment_mode', $mode );
		$order->save();

		/* translators: %s: the platform's payment id. */
		$order->set_status( 'on-hold', sprintf( __( 'Payment %s created on the platform. Waiting for the platform to confirm it.', 'kd-payments' ), $payment_id ) );
		$order->save();
		wc_reduce_stock_levels( $order_id );

		if ( function_exists( 'WC' ) && WC()->cart instanceof WC_Cart ) {
			WC()->cart->empty_cart();
		}

		return array(
			'result'   => 'success',
			'redirect' => $order->get_checkout_order_received_url(),
		);
	}

	/**
	 * The order total in minor units, without a float subtraction in the wrong place.
	 *
	 * `wc_format_decimal` gives a two-place string, which is parsed as a string rather than multiplied as a float: a
	 * total of `19.99` must be exactly `1999`, not `1998` or `2000` because of binary floating point.
	 *
	 * @param WC_Order $order The order being paid.
	 */
	private function amount_minor_of( WC_Order $order ): int {
		$decimal = wc_format_decimal( $order->get_total(), 2 );
		$parts   = explode( '.', $decimal );
		$whole   = isset( $parts[0] ) ? (int) $parts[0] : 0;
		$cents   = isset( $parts[1] ) ? str_pad( (string) $parts[1], 2, '0' ) : '00';

		return ( $whole * 100 ) + (int) substr( $cents, 0, 2 );
	}

	/**
	 * The shop's stable key for this order's payment.
	 *
	 * Stable across a retried checkout, because it is derived from the order rather than from a clock or a request: the
	 * order id, its key and its total. Different for a different total, so a customer who edits their cart and returns
	 * is a new payment rather than a replay of the old amount.
	 *
	 * @param WC_Order $order  The order being paid.
	 * @param int      $amount The total in minor units.
	 */
	private function idempotency_key_of( WC_Order $order, int $amount ): string {
		$digest = hash( 'sha256', $order->get_order_key() . '|' . (string) $amount . '|' . self::CURRENCY );

		return 'kd-wc-' . $order->get_id() . '-' . substr( $digest, 0, 16 );
	}

	/** The sentence a customer reads when the platform refuses or cannot be reached. */
	private function failure_sentence( int $status ): string {
		if ( 401 === $status || 403 === $status ) {
			return __( 'This shop is not connected to the platform yet. Please contact the store.', 'kd-payments' );
		}

		if ( 422 === $status ) {
			return __( 'The platform refused this order. Please contact the store.', 'kd-payments' );
		}

		if ( 429 === $status ) {
			return __( 'Too many attempts. Please try again in a minute.', 'kd-payments' );
		}

		return __( 'The payment could not be started. Please try again.', 'kd-payments' );
	}
}
