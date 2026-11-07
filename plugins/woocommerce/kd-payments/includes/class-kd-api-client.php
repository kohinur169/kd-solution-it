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

/** One call to the platform's connection resource. */
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

	/** The URL of the one resource this plugin uses. */
	public function connection_url(): string {
		return $this->api_base . '/api/public/v1/stores/woocommerce/connection';
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
	 * One authenticated request, and the platform's answer reduced to what a screen needs.
	 *
	 * No redirects are followed, the platform's TLS certificate is verified, and the response body is parsed only when
	 * the status says there is one - a plugin that trusts whatever comes back over the network is a plugin that shows a
	 * merchant an attacker's text.
	 *
	 * @param string               $method HTTP method.
	 * @param string               $url    Absolute URL, built here rather than from a request.
	 * @param array<string, mixed> $body   JSON body, or an empty array.
	 * @return array{ok: bool, status: int, body: array<string, mixed>, error: string}
	 */
	private function request( string $method, string $url, array $body = array() ): array {
		$args = array(
			'method'      => $method,
			'timeout'     => self::TIMEOUT_SECONDS,
			'sslverify'   => true,
			'redirection' => 0,
			'headers'     => array(
				'Authorization' => 'Bearer ' . $this->api_key,
				'Accept'        => 'application/json',
				'Content-Type'  => 'application/json',
				'User-Agent'    => 'kd-payments-woocommerce/' . KD_PAYMENTS_VERSION,
			),
		);

		if ( array() !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );

		if ( is_wp_error( $response ) ) {
			// The transport's own message can carry a host name, so it is reduced to a code the screen translates.
			return array(
				'ok'     => false,
				'status' => 0,
				'body'   => array(),
				'error'  => 'unreachable',
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = (string) wp_remote_retrieve_body( $response );
		$parsed = json_decode( $raw, true );

		return array(
			'ok'     => $status >= 200 && $status < 300,
			'status' => $status,
			'body'   => is_array( $parsed ) ? $parsed : array(),
			'error'  => $status >= 200 && $status < 300 ? '' : $this->error_of( $status, $parsed ),
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
