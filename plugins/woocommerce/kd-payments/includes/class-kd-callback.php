<?php
// path: plugins/woocommerce/kd-payments/includes/class-kd-callback.php

/**
 * The endpoint the platform calls: `https://{shop}/?wc-api=kd_payments_callback`.
 *
 * ## The order of the checks, and why each one is where it is
 *
 *   1. **The store's own token, in constant time.** The platform sends the token this shop minted on activation, and
 *      nothing else can stand in for it: no signature the shop cannot verify, no nonce the shop cannot issue, no
 *      session. `hash_equals` rather than `===` because a comparison that returns early on the first wrong byte tells
 *      an attacker how much of a guess was right.
 *   2. **A body ceiling, before the body is read.** This endpoint is on the public internet, so it must not be a way to
 *      spend a shop's memory: the declared length is refused first, and what is read is bounded by the ceiling.
 *   3. **The envelope's shape, field by field.** A JSON object with four known keys, a callback id of the platform's
 *      own shape, and a payment id - and anything else is refused rather than ignored, because an ignored field is a
 *      field somebody will one day rely on.
 *   4. **The order, found by the payment id this shop stored at checkout.** Never by anything in the body: a body that
 *      could name an order could name somebody else's.
 *   5. **The platform's own answer, asked server to server.** The callback says what changed; this shop asks what is
 *      true. An attacker who learned a token could send notifications - and would still not be able to mark an order
 *      paid, because the status this endpoint applies is the one the platform's API returns.
 *   6. **Idempotency, by the callback's id.** A redelivery is the same callback, and the order is not touched twice.
 *
 * ## What it never does
 *
 * It never prints the token, never logs the body, never trusts the body's status, never moves an order out of a paid
 * state, and never answers `200` for something it did not do - a `503` is how the platform is told to try again.
 */

defined( 'ABSPATH' ) || exit;

/** Receives the platform's payment callback and applies it to the order it is about. */
class KD_Callback {

	/** WooCommerce's own route name, which is the `wc-api` query value the platform calls. */
	const ROUTE = 'kd_payments_callback';

	/** The largest body this endpoint will parse. A callback is a few hundred bytes. */
	const MAXIMUM_BODY_BYTES = 65536;

	/** The id shapes the platform writes, so a body that is not one is refused before a query. */
	const CALLBACK_ID_PATTERN = '/^cbt_[0-9a-f]{32}$/';
	const PAYMENT_ID_PATTERN  = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';
	const TYPE_PATTERN        = '/^payment\.[a-z_]{3,32}$/';

	/** The states that mean the money arrived. */
	const PAID_STATUSES = array( 'authorized', 'captured', 'settled' );

	/** The states that mean it did not and will not. */
	const FAILED_STATUSES = array( 'failed', 'voided' );

	/** Hook the route WooCommerce already knows how to dispatch. */
	public function register(): void {
		add_action( 'woocommerce_api_' . self::ROUTE, array( $this, 'handle' ) );
	}

	/**
	 * One callback.
	 *
	 * Every exit is a status and a small JSON body: the platform reads the status, a human reading a log reads the
	 * reason, and neither gets a stack trace or a secret.
	 */
	public function handle(): void {
		if ( ! $this->is_authorised() ) {
			$this->respond( 401, array( 'handled' => false, 'reason' => 'unauthorized' ) );

			return;
		}

		$raw = $this->read_body();

		if ( null === $raw ) {
			$this->respond( 413, array( 'handled' => false, 'reason' => 'body_too_large' ) );

			return;
		}

		$envelope = json_decode( $raw, true );

		if ( ! is_array( $envelope ) || ! $this->is_envelope( $envelope ) ) {
			$this->respond( 400, array( 'handled' => false, 'reason' => 'body_malformed' ) );

			return;
		}

		$callback_id = (string) $envelope['id'];
		$payment_id  = (string) $envelope['payment']['id'];
		$order       = $this->order_of( $payment_id );

		if ( ! $order instanceof WC_Order ) {
			// The order was deleted, or this shop never created this payment. Either way the platform should stop, so
			// the answer is a success it can act on rather than a status it would retry.
			$this->respond( 200, array( 'handled' => false, 'reason' => 'order_not_found' ) );

			return;
		}

		if ( $callback_id === $order->get_meta( KD_Payment_Gateway::CALLBACK_ID_META ) ) {
			$this->respond( 200, array( 'handled' => true, 'duplicate' => true ) );

			return;
		}

		$status = $this->confirmed_status_of( $payment_id );

		if ( null === $status ) {
			// The platform could not be asked, so this shop does not know the truth yet and must not guess. `503` is
			// the one answer that asks the platform to call again.
			$this->respond( 503, array( 'handled' => false, 'reason' => 'platform_unavailable' ) );

			return;
		}

		$this->apply( $order, $callback_id, $payment_id, $status );

		$this->respond( 200, array( 'handled' => true, 'status' => $status ) );
	}

	/**
	 * The request body, read no further than the ceiling.
	 *
	 * The declared `Content-Length` is checked first, so an announced oversize body is answered without reading a byte,
	 * and then at most `MAXIMUM_BODY_BYTES + 1` bytes are read - a request with no length, or with one that lies, still
	 * cannot make this endpoint hold more of somebody else's text than the ceiling allows. Reading first and measuring
	 * afterwards would have answered `413` only after the memory had already been spent, which is not a ceiling at all.
	 *
	 * @return string|null The body, or null when it is larger than the ceiling.
	 */
	private function read_body(): ?string {
		$declared = isset( $_SERVER['CONTENT_LENGTH'] ) && is_string( $_SERVER['CONTENT_LENGTH'] )
			? (int) $_SERVER['CONTENT_LENGTH']
			: 0;

		if ( $declared > self::MAXIMUM_BODY_BYTES ) {
			return null;
		}

		$handle = fopen( 'php://input', 'rb' );

		if ( false === $handle ) {
			return '';
		}

		$raw = stream_get_contents( $handle, self::MAXIMUM_BODY_BYTES + 1 );

		fclose( $handle );

		if ( ! is_string( $raw ) || strlen( $raw ) > self::MAXIMUM_BODY_BYTES ) {
			return null;
		}

		return $raw;
	}

	/**
	 * Whether the caller presented this shop's own token.
	 *
	 * The header can arrive in three shapes depending on the server (Apache with `CGI`, FastCGI, or a proxy that
	 * rewrote it), which is why all three are read - and the comparison is `hash_equals` in every one of them.
	 */
	private function is_authorised(): bool {
		$header = '';

		if ( isset( $_SERVER['HTTP_AUTHORIZATION'] ) && is_string( $_SERVER['HTTP_AUTHORIZATION'] ) ) {
			$header = sanitize_text_field( wp_unslash( $_SERVER['HTTP_AUTHORIZATION'] ) );
		} elseif ( isset( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) && is_string( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ) {
			$header = sanitize_text_field( wp_unslash( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) );
		} elseif ( function_exists( 'getallheaders' ) ) {
			// The third shape: a host that fills neither superglobal still hands the header to PHP's own accessor.
			foreach ( getallheaders() as $name => $value ) {
				if ( is_string( $name ) && is_string( $value ) && 0 === strcasecmp( $name, 'Authorization' ) ) {
					$header = sanitize_text_field( $value );

					break;
				}
			}
		}

		if ( 0 === stripos( $header, 'Bearer ' ) ) {
			$header = substr( $header, 7 );
		}

		$header = trim( $header );
		$own    = KD_Connection::store_token();

		return '' !== $header && '' !== $own && hash_equals( $own, $header );
	}

	/**
	 * Whether a parsed body is the platform's envelope and nothing else.
	 *
	 * Six keys, and the list is the platform's own (`lib/api/store-callback-fields.ts`): the shape is checked, not just
	 * the fields the handler happens to read, because a body that carries extra keys is a body written by something that
	 * does not know this contract - and a body that is missing one is a body written by something that only looks like it.
	 *
	 * @param array<mixed> $envelope The decoded body.
	 */
	private function is_envelope( array $envelope ): bool {
		if ( array( 'created', 'id', 'object', 'payment', 'store', 'type' ) !== $this->sorted_keys( $envelope ) ) {
			return false;
		}

		if ( 'payment_callback' !== $envelope['object'] ) {
			return false;
		}

		if ( ! is_int( $envelope['created'] ) || $envelope['created'] <= 0 ) {
			return false;
		}

		if ( ! is_string( $envelope['id'] ) || 1 !== preg_match( self::CALLBACK_ID_PATTERN, $envelope['id'] ) ) {
			return false;
		}

		if ( ! is_string( $envelope['type'] ) || 1 !== preg_match( self::TYPE_PATTERN, $envelope['type'] ) ) {
			return false;
		}

		if ( ! is_array( $envelope['store'] ) || ! isset( $envelope['store']['domain'] ) || ! is_string( $envelope['store']['domain'] ) ) {
			return false;
		}

		if ( ! is_array( $envelope['payment'] ) || ! isset( $envelope['payment']['id'] ) ) {
			return false;
		}

		$payment_id = $envelope['payment']['id'];

		return is_string( $payment_id ) && 1 === preg_match( self::PAYMENT_ID_PATTERN, $payment_id );
	}

	/**
	 * The keys of an array, in the order a comparison needs.
	 *
	 * @param array<mixed> $value The array whose keys are wanted.
	 * @return array<int, string>
	 */
	private function sorted_keys( array $value ): array {
		$keys = array_map( 'strval', array_keys( $value ) );
		sort( $keys );

		return $keys;
	}

	/**
	 * The order this shop created the payment for, or null.
	 *
	 * ## Why the result is verified rather than trusted
	 *
	 * WooCommerce has two order stores and they do not answer the same arguments: the high performance tables document
	 * `meta_query`, and a legacy post store answers `meta_key`/`meta_value`. A query the active store does not
	 * understand is not an error - it is **silently ignored**, and an ignored filter returns the newest orders instead
	 * of the one this callback is about. Paying the wrong customer's order is the worst thing this endpoint could do,
	 * so every candidate is checked against the payment id the gateway actually wrote and anything else is discarded.
	 *
	 * @param string $payment_id The platform's payment id.
	 */
	private function order_of( string $payment_id ): ?WC_Order {
		foreach ( $this->candidate_orders( $payment_id ) as $order ) {
			if ( $payment_id === (string) $order->get_meta( KD_Payment_Gateway::PAYMENT_ID_META ) ) {
				return $order;
			}
		}

		return null;
	}

	/**
	 * What the two documented queries offer as candidates, newest first, without duplicates.
	 *
	 * Both are asked only until one answers, and neither answer is used without being verified by the caller.
	 *
	 * @param string $payment_id The platform's payment id.
	 * @return array<int, WC_Order>
	 */
	private function candidate_orders( string $payment_id ): array {
		$queries = array(
			array(
				'limit'      => 5,
				'return'     => 'objects',
				'orderby'    => 'date',
				'order'      => 'DESC',
				'meta_query' => array(
					array(
						'key'     => KD_Payment_Gateway::PAYMENT_ID_META,
						'value'   => $payment_id,
						'compare' => '=',
					),
				),
			),
			array(
				'limit'        => 5,
				'return'       => 'objects',
				'orderby'      => 'date',
				'order'        => 'DESC',
				'meta_key'     => KD_Payment_Gateway::PAYMENT_ID_META,
				'meta_value'   => $payment_id,
				'meta_compare' => '=',
			),
		);
		$candidates = array();

		foreach ( $queries as $args ) {
			foreach ( wc_get_orders( $args ) as $order ) {
				if ( $order instanceof WC_Order ) {
					$candidates[ $order->get_id() ] = $order;
				}
			}

			if ( array() !== $candidates ) {
				break;
			}
		}

		return array_values( $candidates );
	}

	/**
	 * The status the platform says the payment has, asked with this shop's own key.
	 *
	 * @param string $payment_id The platform's payment id.
	 */
	private function confirmed_status_of( string $payment_id ): ?string {
		$client = new KD_Api_Client( KD_Connection::api_key(), kd_payments_api_base() );
		$answer = $client->payment_status( $payment_id );

		if ( ! $answer['ok'] ) {
			return null;
		}

		// The answer must be about the payment this callback names. A read that came back with another id is a read
		// this shop cannot use, and applying it would move an order on somebody else's status.
		$answered_id = isset( $answer['body']['id'] ) && is_string( $answer['body']['id'] ) ? $answer['body']['id'] : '';

		if ( $payment_id !== $answered_id ) {
			return null;
		}

		$status = isset( $answer['body']['status'] ) && is_string( $answer['body']['status'] ) ? $answer['body']['status'] : '';

		return '' === $status ? null : $status;
	}

	/**
	 * Move the order to what the platform says, once.
	 *
	 * @param WC_Order $order       The order the payment belongs to.
	 * @param string   $callback_id The callback's own id.
	 * @param string   $payment_id  The platform's payment id.
	 * @param string   $status      The platform's authoritative status.
	 */
	private function apply( WC_Order $order, string $callback_id, string $payment_id, string $status ): void {
		if ( in_array( $status, self::PAID_STATUSES, true ) ) {
			if ( ! $order->is_paid() ) {
				// WooCommerce's own path: it records the transaction, reduces stock, fires the emails and moves the
				// order to processing or completed by the shop's own rules.
				$order->payment_complete( $payment_id );
			}
		} elseif ( in_array( $status, self::FAILED_STATUSES, true ) ) {
			if ( $order->is_paid() ) {
				// The money is already taken. A later callback must not un-pay an order - only a refund moves a paid
				// order, and it moves it forward - so this is recorded and the status is left alone.
				/* translators: %s: the platform's status word. */
				$order->add_order_note( sprintf( __( 'The platform reported the payment as %s, but this order is already paid. The order was left as it is.', 'kd-payments' ), $status ) );
			} else {
				/* translators: %s: the platform's status word. */
				$order->set_status( 'failed', sprintf( __( 'The platform reported the payment as %s.', 'kd-payments' ), $status ) );
			}
		} elseif ( 'refunded' === $status ) {
			$order->set_status( 'refunded', __( 'The platform reported the payment as refunded.', 'kd-payments' ) );
		} else {
			/* translators: %s: the platform's status word. */
			$order->add_order_note( sprintf( __( 'The platform reported the payment as %s. No order status change.', 'kd-payments' ), $status ) );
		}

		$order->update_meta_data( KD_Payment_Gateway::CALLBACK_ID_META, $callback_id );
		$order->update_meta_data( KD_Payment_Gateway::PAYMENT_STATUS_META, $status );
		$order->save();
	}

	/**
	 * Answer, and stop.
	 *
	 * The status goes through WordPress's own helper, the body through `wp_json_encode`, and nothing here prints a
	 * variable the platform sent.
	 *
	 * @param int                  $status  The HTTP status.
	 * @param array<string, mixed> $payload The body.
	 */
	private function respond( int $status, array $payload ): void {
		status_header( $status );
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'X-Robots-Tag: noindex' );

		echo wp_json_encode( $payload );

		exit;
	}
}
