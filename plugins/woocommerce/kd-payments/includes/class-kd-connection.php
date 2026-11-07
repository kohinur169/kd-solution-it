<?php
// path: plugins/woocommerce/kd-payments/includes/class-kd-connection.php

/**
 * What this store knows about its own connection, and the three actions that change it.
 *
 * The plugin never stores a status it invented: every value here came from the platform in the last answer, and the
 * only thing kept between requests is that answer plus the two secrets - the merchant's API key and this store's token.
 */

defined( 'ABSPATH' ) || exit;

/** The connection between this store and the platform. */
class KD_Connection {

	/** The option holding the merchant's API key. Never autoloaded. */
	const API_KEY_OPTION = 'kd_payments_api_key';

	/** The option holding this store's own token. Never autoloaded. */
	const STORE_TOKEN_OPTION = 'kd_payments_store_token';

	/** The option holding the last answer the platform gave. */
	const CONNECTION_OPTION = 'kd_payments_connection';

	/**
	 * This store's bare domain, as the platform stores it.
	 *
	 * Derived from the site itself rather than typed by the merchant: the store is the only thing that knows its own
	 * address, and a domain field a merchant can mistype is a connection to somebody else's shop.
	 */
	public static function store_domain(): string {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$host = is_string( $host ) ? strtolower( $host ) : '';

		return $host;
	}

	/**
	 * The path this WordPress is installed under, with the slashes trimmed - empty at a domain root.
	 *
	 * The platform derives a shop's callback address from the domain alone (`https://{domain}/?wc-api=kd_payments_callback`),
	 * because a connection row stores a bare host and this STEP does not add a path column. A shop installed at
	 * `https://example.com/shop/` answers only at `https://example.com/shop/?wc-api=...`, so the derived address would
	 * 404 on every payment. The handshake refuses such a site rather than connecting it to a callback it cannot receive.
	 */
	public static function install_path(): string {
		$path = wp_parse_url( home_url(), PHP_URL_PATH );
		$path = is_string( $path ) ? trim( $path, '/' ) : '';

		return $path;
	}

	/** The API key the merchant saved, or an empty string. */
	public static function api_key(): string {
		$key = get_option( self::API_KEY_OPTION, '' );

		return is_string( $key ) ? $key : '';
	}

	/**
	 * Save the API key the merchant typed.
	 *
	 * The value is sanitised and trimmed, never echoed back, and the option is not autoloaded.
	 *
	 * @param string $api_key The key from the merchant's platform screen.
	 */
	public static function save_api_key( string $api_key ): void {
		$clean = trim( sanitize_text_field( $api_key ) );

		update_option( self::API_KEY_OPTION, $clean, false );
	}

	/**
	 * This store's token, minted on activation.
	 *
	 * The store owns this secret: the platform seals what it is sent and uses it to authenticate its own calls here, so
	 * the plugin never has to receive one.
	 */
	public static function store_token(): string {
		$token = get_option( self::STORE_TOKEN_OPTION, '' );

		if ( ! is_string( $token ) || '' === $token ) {
			$token = bin2hex( random_bytes( 32 ) );

			update_option( self::STORE_TOKEN_OPTION, $token, false );
		}

		return $token;
	}

	/** The last answer the platform gave, or an empty array. */
	public static function last_answer(): array {
		$answer = get_option( self::CONNECTION_OPTION, array() );

		return is_array( $answer ) ? $answer : array();
	}

	/** Whether the last answer said the connection is active. */
	public static function is_active(): bool {
		$answer = self::last_answer();

		return isset( $answer['status'] ) && 'active' === $answer['status'];
	}

	/** The client for this store, or null when no key has been saved. */
	private function client(): ?KD_Api_Client {
		$key  = self::api_key();
		$base = kd_payments_api_base();

		if ( '' === $key || '' === $base ) {
			return null;
		}

		return new KD_Api_Client( $key, $base );
	}

	/**
	 * The login: send this store's domain and token, and keep what the platform answers.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public function connect(): array {
		$client = $this->client();

		if ( null === $client ) {
			return array(
				'ok'      => false,
				'message' => __( 'Add your API key before connecting.', 'kd-payments' ),
			);
		}

		$domain = self::store_domain();

		if ( '' === $domain ) {
			return array(
				'ok'      => false,
				'message' => __( 'This site has no domain the platform can reach.', 'kd-payments' ),
			);
		}

		if ( '' !== self::install_path() ) {
			return array(
				'ok'      => false,
				'message' => __( 'This WordPress is installed in a subdirectory. The platform calls a shop at its domain root, so a callback to this site would not arrive. Move the shop to the root of its domain before connecting.', 'kd-payments' ),
			);
		}

		$answer = $client->connect( $domain, self::store_token() );

		return $this->remember( $answer, __( 'Connected.', 'kd-payments' ) );
	}

	/**
	 * Refresh the status from the platform.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public function refresh(): array {
		$client = $this->client();

		if ( null === $client ) {
			return array(
				'ok'      => false,
				'message' => __( 'Add your API key before checking the connection.', 'kd-payments' ),
			);
		}

		$answer = $client->status( self::store_domain() );

		if ( 404 === $answer['status'] ) {
			delete_option( self::CONNECTION_OPTION );

			return array(
				'ok'      => false,
				'message' => __( 'This store is not connected.', 'kd-payments' ),
			);
		}

		return $this->remember( $answer, __( 'Status refreshed.', 'kd-payments' ) );
	}

	/**
	 * The newest payment this shop created, so the screen can offer to test a callback against a real one.
	 *
	 * The shop is the only party that knows which payments it made - the platform would need a store reference on the
	 * payment row to answer this, and STEP 203's row has none - so the search starts here, over this shop's own orders.
	 *
	 * @return array{payment_id: string, order_id: int}|null
	 */
	public static function newest_payment(): ?array {
		$orders = wc_get_orders(
			array(
				'limit'   => 10,
				'return'  => 'objects',
				'orderby' => 'date',
				'order'   => 'DESC',
				'status'  => array( 'on-hold', 'pending', 'processing', 'completed' ),
			)
		);

		foreach ( $orders as $order ) {
			if ( ! $order instanceof WC_Order ) {
				continue;
			}

			$payment_id = (string) $order->get_meta( KD_Payment_Gateway::PAYMENT_ID_META );

			if ( '' !== $payment_id ) {
				return array(
					'payment_id' => $payment_id,
					'order_id'   => $order->get_id(),
				);
			}
		}

		return null;
	}

	/**
	 * Ask the platform to call this shop about the newest payment, and say what happened.
	 *
	 * A merchant's own test of the callback: the platform makes the real request, to the real address, with the real
	 * store token. The answer's `delivered` and `rule` are what the screen repeats - and nothing here marks an order
	 * paid, because only the callback endpoint may do that, and only after asking the platform.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public function test_callback(): array {
		$client = $this->client();

		if ( null === $client ) {
			return array(
				'ok'      => false,
				'message' => __( 'Add your API key before testing the callback.', 'kd-payments' ),
			);
		}

		$newest = self::newest_payment();

		if ( null === $newest ) {
			return array(
				'ok'      => false,
				'message' => __( 'No order has a platform payment yet, so there is nothing to call this shop about.', 'kd-payments' ),
			);
		}

		$answer = $client->request_callback( $newest['payment_id'] );

		if ( ! $answer['ok'] ) {
			return array(
				'ok'      => false,
				'message' => $this->sentence_for( $answer['status'], $answer['error'] ),
			);
		}

		$delivered = isset( $answer['body']['delivered'] ) && true === $answer['body']['delivered'];
		$rule      = isset( $answer['body']['rule'] ) && is_string( $answer['body']['rule'] ) ? $answer['body']['rule'] : '';

		if ( $delivered ) {
			return array(
				'ok'      => true,
				'message' => __( 'The platform called this shop and it answered. The callback path works.', 'kd-payments' ),
			);
		}

		return array(
			'ok'      => false,
			'message' => '' === $rule
				? __( 'The platform could not deliver the callback to this shop.', 'kd-payments' )
				: sprintf(
					/* translators: %s: the platform's machine word for what went wrong. */
					__( 'The platform could not deliver the callback to this shop (%s).', 'kd-payments' ),
					$rule
				),
		);
	}

	/**
	 * The disconnect: tell the platform to revoke, and forget the local answer when it agrees.
	 *
	 * @return array{ok: bool, message: string}
	 */
	public function disconnect(): array {
		$client = $this->client();

		if ( null === $client ) {
			return array(
				'ok'      => false,
				'message' => __( 'There is nothing to disconnect without an API key.', 'kd-payments' ),
			);
		}

		$answer = $client->disconnect( self::store_domain() );

		if ( $answer['ok'] ) {
			delete_option( self::CONNECTION_OPTION );

			return array(
				'ok'      => true,
				'message' => __( 'Disconnected. The store connection is revoked.', 'kd-payments' ),
			);
		}

		return $this->remember( $answer, __( 'Disconnected.', 'kd-payments' ) );
	}

	/**
	 * Keep the platform's answer when it succeeded, and translate a refusal into a sentence.
	 *
	 * Only fields this plugin knows are stored, so a future platform field cannot end up rendered as HTML by a plugin
	 * that was never updated to escape it.
	 *
	 * @param array{ok: bool, status: int, body: array<string, mixed>, error: string} $answer The platform's answer.
	 * @param string                                                                  $success The sentence to show on success.
	 * @return array{ok: bool, message: string}
	 */
	private function remember( array $answer, string $success ): array {
		if ( ! $answer['ok'] ) {
			return array(
				'ok'      => false,
				'message' => $this->sentence_for( $answer['status'], $answer['error'] ),
			);
		}

		$body = $answer['body'];

		update_option(
			self::CONNECTION_OPTION,
			array(
				'id'                    => isset( $body['id'] ) && is_string( $body['id'] ) ? $body['id'] : '',
				'platform'              => isset( $body['platform'] ) && is_string( $body['platform'] ) ? $body['platform'] : '',
				'store_domain'          => isset( $body['store_domain'] ) && is_string( $body['store_domain'] ) ? $body['store_domain'] : '',
				'status'                => isset( $body['status'] ) && is_string( $body['status'] ) ? $body['status'] : '',
				'external_store_id'     => isset( $body['external_store_id'] ) && is_string( $body['external_store_id'] ) ? $body['external_store_id'] : '',
				'connected_at'          => isset( $body['connected_at'] ) && is_string( $body['connected_at'] ) ? $body['connected_at'] : '',
				'store_token_last_four' => isset( $body['store_token_last_four'] ) && is_string( $body['store_token_last_four'] ) ? $body['store_token_last_four'] : '',
			),
			false
		);

		return array(
			'ok'      => true,
			'message' => $success,
		);
	}

	/**
	 * The sentence a merchant reads for a refusal.
	 *
	 * The plugin owns its own words: the platform's message is for developers, and a translated sentence on the store's
	 * admin is what a merchant can act on.
	 *
	 * @param int    $status HTTP status the platform answered.
	 * @param string $error  The machine word the platform refused with.
	 */
	private function sentence_for( int $status, string $error ): string {
		if ( 401 === $status || 403 === $status ) {
			return __( 'The platform did not accept that API key.', 'kd-payments' );
		}

		if ( 409 === $status ) {
			return __( 'The platform refused the connection: this store is either revoked or holding a different token than the one on file. Neither can be repaired from here - contact support.', 'kd-payments' );
		}

		if ( 422 === $status ) {
			return __( 'The platform refused the store details. Check the API key and the site address.', 'kd-payments' );
		}

		if ( 429 === $status ) {
			return __( 'Too many attempts. Wait a minute and try again.', 'kd-payments' );
		}

		if ( 0 === $status ) {
			return __( 'The platform could not be reached. Check this site can make outgoing HTTPS requests.', 'kd-payments' );
		}

		return '' === $error
			? __( 'The platform answered with an error.', 'kd-payments' )
			: sprintf(
				/* translators: %s: the platform's machine word for the refusal, for a support ticket. */
				__( 'The platform answered with an error (%s).', 'kd-payments' ),
				$error
			);
	}
}
