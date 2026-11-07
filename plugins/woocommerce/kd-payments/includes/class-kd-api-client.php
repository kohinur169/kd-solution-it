<?php
// path: plugins/woocommerce/kd-payments/includes/class-kd-api-client.php

/**
 * The only code in this plugin that talks to the platform.
 *
 * Three requests, one for each verb of `section 20`'s connection resource, and every one of them carries the merchant's
 * API key and nothing else: the platform derives the merchant from that key, so the plugin never sends a company id it
 * could get wrong.
 */

defined( 'ABSPATH' ) || exit;

/** One call to the platform: the connection handshake, a payment, and a payment's status. */
class KD_Api_Client {

	/**
	 * How long a call may take.
	 *
	 * The platform answers a connection call without contacting the store, so ten seconds is already generous; a
	 * shorter one would turn a slow staging platform into a false failure.
	 */
	const TIMEOUT_SECONDS = 10;

	/** The API key this store was given by the merchant. */
	private string $api_key;

	/** Where the platform lives, without a trailing slash. */
	private string $api_base;

	public function __construct( string $api_key, string $api_base ) {
		$this->api_key  = $api_key;
		$this->api_base = untrailingslashit( $api_base );
	}

	/** The URL of the connection resource. */
	public function connection_url(): string {
		return $this->api_base . '/api/public/v1/stores/woocommerce/connection';
	}

	/** The URL a payment is created on. */
	public function payments_url(): string {
		return $this->api_base . '/api/public/v1/payments';
	}

	/** The URL of one payment. */
	public function payment_url( string $payment_id ): string {
		return $this->payments_url() . '/' . rawurlencode( $payment_id );
	}

	/** The URL that asks the platform to call this shop about one payment. */
	public function callback_url( string $payment_id ): string {
		return $this->payment_url( $payment_id ) . '/callback';
	}

	/**
	 * Activate the connection.
	 *
	 * @param string $store_domain The bare domain of this store, as the platform stores it.
	 * @param string $store_token  The token this store minted for the platform's calls.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string}
	 */
	public function connect( string $store_domain, string $store_token ): array {
		return $this->request(
			'POST',
			$this->connection_url(),
			array(
				'store_domain' => $store_domain,
				'store_token'  => $store_token,
			)
		);
	}

	/**
	 * Ask whether this store is connected.
	 *
	 * @param string $store_domain The bare domain of this store.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string}
	 */
	public function status( string $store_domain ): array {
		return $this->request(
			'GET',
			add_query_arg( 'store_domain', $store_domain, $this->connection_url() )
		);
	}

	/**
	 * Disconnect this store.
	 *
	 * @param string $store_domain The bare domain of this store.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string}
	 */
	public function disconnect( string $store_domain ): array {
		return $this->request(
			'DELETE',
			add_query_arg( 'store_domain', $store_domain, $this->connection_url() )
		);
	}

	/**
	 * Create a payment for one order.
	 *
	 * The idempotency key is the shop's own derivation over the order, so a checkout the customer submits twice - or a
	 * shop whose request times out and retries - is one payment on the platform rather than two charges.
	 *
	 * @param int    $amount_minor    The order total in minor units.
	 * @param string $currency        The currency, which the platform accepts as USD only.
	 * @param string $method          How the payer will pay.
	 * @param string $idempotency_key The shop's stable key for this order.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string, replayed: bool}
	 */
	public function create_payment(
		int $amount_minor,
		string $currency,
		string $method,
		string $idempotency_key
	): array {
		return $this->request(
			'POST',
			$this->payments_url(),
			array(
				'amount_minor' => $amount_minor,
				'currency'     => $currency,
				'method'       => $method,
			),
			array( 'idempotency-key' => $idempotency_key )
		);
	}

	/**
	 * Read one payment's status, server to server.
	 *
	 * This is the call that makes a callback safe: the shop is told what changed, and then it asks - with its own key -
	 * before it touches an order.
	 *
	 * @param string $payment_id The payment's id.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string, replayed: bool}
	 */
	public function payment_status( string $payment_id ): array {
		return $this->request( 'GET', $this->payment_url( $payment_id ) );
	}

	/**
	 * Ask the platform to call this shop about one payment, now.
	 *
	 * This is the merchant's own test of the whole path - the platform's `POST` to the shop's endpoint, the store token
	 * the shop will compare, and the shop's answer - without waiting for a real payment to change state. The platform
	 * reports what the shop did, so the screen can say whether the integration works.
	 *
	 * @param string $payment_id The payment the callback is about.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string, replayed: bool}
	 */
	public function request_callback( string $payment_id ): array {
		return $this->request( 'POST', $this->callback_url( $payment_id ) );
	}

	/**
	 * One authenticated request, and the platform's answer reduced to what a screen needs.
	 *
	 * No redirects are followed, the platform's TLS certificate is verified, and the response body is parsed only when
	 * the status says there is one - a plugin that trusts whatever comes back over the network is a plugin that shows a
	 * merchant an attacker's text.
	 *
	 * @param string                $method        HTTP method.
	 * @param string                $url           Absolute URL, built here rather than from a request.
	 * @param array<string, mixed>  $body          JSON body, or an empty array.
	 * @param array<string, string> $extra_headers Headers this call adds, such as the idempotency key.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string, replayed: bool}
	 */
	private function request(
		string $method,
		string $url,
		array $body = array(),
		array $extra_headers = array()
	): array {
		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT_SECONDS,
			'sslverify'   => true,
			'redirection' => 0,
			'headers'     => array_merge(
				array(
					'Authorization' => 'Bearer ' . $this->api_key,
					'Accept'        => 'application/json',
					'Content-Type'  => 'application/json',
					'User-Agent'    => 'kd-payments-woocommerce/' . KD_PAYMENTS_VERSION,
				),
				$extra_headers
			),
		);

		if ( array() !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			// The transport's own message can carry a host name, so it is reduced to a code the screen translates.
			return array(
				'ok'       => false,
				'status'   => 0,
				'body'     => array(),
				'error'    => 'unreachable',
				'replayed' => false,
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = (string) wp_remote_retrieve_body( $response );
		$parsed = json_decode( $raw, true );
		$ok     = $status >= 200 && $status < 300;

		return array(
			'ok'       => $ok,
			'status'   => $status,
			'body'     => is_array( $parsed ) ? $parsed : array(),
			'error'    => $ok ? '' : $this->error_of( $status, $parsed ),
			'replayed' => 'true' === wp_remote_retrieve_header( $response, 'idempotency-replayed' ),
		);
	}

	/**
	 * The machine word the platform refused with, or a word for the status.
	 *
	 * The platform's error envelope is `{error: {code, message, requestId}}`, and the plugin shows its own sentence
	 * rather than the platform's, so a stale platform string can never appear in a merchant's admin.
	 *
	 * @param int   $status HTTP status.
	 * @param mixed $parsed Decoded body, if any.
	 */
	private function error_of( int $status, mixed $parsed ): string {
		if ( is_array( $parsed ) && isset( $parsed['error'] ) && is_array( $parsed['error'] ) ) {
			$code = $parsed['error']['code'] ?? '';

			if ( is_string( $code ) && '' !== $code && preg_match( '/^[A-Z_]+$/', $code ) ) {
				return strtolower( $code );
			}
		}

		return 0 === $status ? 'unreachable' : 'http_' . $status;
	}
}
