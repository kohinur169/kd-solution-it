<?php
// path: plugins/woocommerce/kd-payments/includes/class-kd-settings.php

/**
 * The one screen this plugin adds: the merchant's login, the status, and the two buttons.
 *
 * Three rules decide everything below, and they are the reason the file is longer than the screen:
 *
 * - **capability first, then nonce, then the action.** A handler that checks a nonce but not a capability lets a
 *   subscriber with a leaked nonce connect a store; a handler that checks a capability but not a nonce lets a
 *   cross-site form do it with the merchant's own cookies.
 * - **every value is escaped where it is printed**, with the escaper that matches where it goes: `esc_html` for text,
 *   `esc_attr` for an attribute, `esc_url` for a URL.
 * - **nothing secret is ever printed.** The API key is write-only in this screen - a merchant who saves it can tell it
 *   was saved from the status beside it, and it is never echoed back into the form.
 */

defined( 'ABSPATH' ) || exit;

/** The settings screen and its three form handlers. */
class KD_Settings {

	/** The page slug, which is also the capability's screen. */
	const PAGE_SLUG = 'kd-payments';

	/** The nonce action of the three forms. */
	const NONCE_ACTION = 'kd_payments_connection';

	/** The nonce field name. */
	const NONCE_FIELD = 'kd_payments_nonce';

	/** The one capability that may change a store connection. */
	const CAPABILITY = 'manage_woocommerce';

	private KD_Connection $connection;

	public function __construct( KD_Connection $connection ) {
		$this->connection = $connection;
	}

	/** Hook the screen and the handlers. */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_post_kd_payments_save_key', array( $this, 'handle_save_key' ) );
		add_action( 'admin_post_kd_payments_connect', array( $this, 'handle_connect' ) );
		add_action( 'admin_post_kd_payments_refresh', array( $this, 'handle_refresh' ) );
		add_action( 'admin_post_kd_payments_disconnect', array( $this, 'handle_disconnect' ) );
	}

	/** The screen, under WooCommerce's own menu where a merchant looks for a store setting. */
	public function add_menu(): void {
		add_submenu_page(
			'woocommerce',
			__( 'KD Payments', 'kd-payments' ),
			__( 'KD Payments', 'kd-payments' ),
			self::CAPABILITY,
			self::PAGE_SLUG,
			array( $this, 'render' )
		);
	}

	/** The screen itself. */
	public function render(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You are not allowed to manage this store connection.', 'kd-payments' ) );
		}

		$answer     = KD_Connection::last_answer();
		$has_key    = '' !== KD_Connection::api_key();
		$is_active  = KD_Connection::is_active();
		$domain     = KD_Connection::store_domain();
		$notice     = get_transient( 'kd_payments_notice_' . get_current_user_id() );
		$has_notice = is_array( $notice ) && isset( $notice['message'] );

		if ( $has_notice ) {
			delete_transient( 'kd_payments_notice_' . get_current_user_id() );
		}

		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'KD Payments', 'kd-payments' ); ?></h1>
			<p class="description">
				<?php esc_html_e( 'Connect this WooCommerce store to the platform. The connection becomes active as soon as the platform accepts your API key.', 'kd-payments' ); ?>
			</p>

			<?php if ( $has_notice ) : ?>
				<div class="notice <?php echo esc_attr( isset( $notice['ok'] ) && $notice['ok'] ? 'notice-success' : 'notice-error' ); ?> is-dismissible">
					<p><?php echo esc_html( (string) $notice['message'] ); ?></p>
				</div>
			<?php endif; ?>

			<table class="form-table" role="presentation">
				<tbody>
					<tr>
						<th scope="row"><?php esc_html_e( 'Store domain', 'kd-payments' ); ?></th>
						<td><code><?php echo esc_html( $domain ); ?></code></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'API key', 'kd-payments' ); ?></th>
						<td>
							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
								<input type="hidden" name="action" value="kd_payments_save_key" />
								<?php wp_nonce_field( self::NONCE_ACTION, self::NONCE_FIELD ); ?>
								<input
									type="password"
									name="kd_payments_api_key"
									class="regular-text"
									autocomplete="off"
									placeholder="<?php echo esc_attr( $has_key ? __( 'Saved. Paste a new key to replace it.', 'kd-payments' ) : __( 'kd_live_... or kd_test_...', 'kd-payments' ) ); ?>"
								/>
								<?php submit_button( __( 'Save key', 'kd-payments' ), 'secondary', 'submit', false ); ?>
							</form>
							<p class="description">
								<?php esc_html_e( 'Create the key on the platform under Developers, API credentials. It is stored on this site and never shown again.', 'kd-payments' ); ?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Connection', 'kd-payments' ); ?></th>
						<td>
							<?php if ( $is_active ) : ?>
								<p>
									<span class="dashicons dashicons-yes-alt" aria-hidden="true"></span>
									<strong><?php esc_html_e( 'Active', 'kd-payments' ); ?></strong>
									<?php if ( isset( $answer['connected_at'] ) && '' !== $answer['connected_at'] ) : ?>
										&mdash; <?php echo esc_html( (string) $answer['connected_at'] ); ?>
									<?php endif; ?>
								</p>
								<?php if ( isset( $answer['external_store_id'] ) && '' !== $answer['external_store_id'] ) : ?>
									<p class="description">
										<?php esc_html_e( 'Store identifier:', 'kd-payments' ); ?>
										<code><?php echo esc_html( (string) $answer['external_store_id'] ); ?></code>
									</p>
								<?php endif; ?>
								<?php if ( isset( $answer['store_token_last_four'] ) && '' !== $answer['store_token_last_four'] ) : ?>
									<p class="description">
										<?php esc_html_e( 'Store token ends in', 'kd-payments' ); ?>
										<code><?php echo esc_html( (string) $answer['store_token_last_four'] ); ?></code>
									</p>
								<?php endif; ?>
							<?php else : ?>
								<p><strong><?php esc_html_e( 'Not connected', 'kd-payments' ); ?></strong></p>
							<?php endif; ?>

							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px;">
								<input type="hidden" name="action" value="kd_payments_connect" />
								<?php wp_nonce_field( self::NONCE_ACTION, self::NONCE_FIELD ); ?>
								<?php submit_button( __( 'Connect', 'kd-payments' ), 'primary', 'submit', false ); ?>
							</form>

							<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-right:8px;">
								<input type="hidden" name="action" value="kd_payments_refresh" />
								<?php wp_nonce_field( self::NONCE_ACTION, self::NONCE_FIELD ); ?>
								<?php submit_button( __( 'Refresh status', 'kd-payments' ), 'secondary', 'submit', false ); ?>
							</form>

							<?php if ( $is_active ) : ?>
								<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;">
									<input type="hidden" name="action" value="kd_payments_disconnect" />
									<?php wp_nonce_field( self::NONCE_ACTION, self::NONCE_FIELD ); ?>
									<?php submit_button( __( 'Disconnect', 'kd-payments' ), 'delete', 'submit', false ); ?>
								</form>
							<?php endif; ?>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<?php
	}

	/** Save the merchant's key, and nothing else. */
	public function handle_save_key(): void {
		$this->authorise();

		$key = isset( $_POST['kd_payments_api_key'] ) && is_string( $_POST['kd_payments_api_key'] )
			? sanitize_text_field( wp_unslash( $_POST['kd_payments_api_key'] ) )
			: '';

		if ( '' === $key ) {
			$this->finish( false, __( 'The key was empty, so nothing was saved.', 'kd-payments' ) );

			return;
		}

		KD_Connection::save_api_key( $key );
		$this->finish( true, __( 'Key saved. Press Connect to activate the connection.', 'kd-payments' ) );
	}

	/** The login: send this store's domain and token to the platform. */
	public function handle_connect(): void {
		$this->authorise();

		$result = $this->connection->connect();

		$this->finish( $result['ok'], $result['message'] );
	}

	/** Ask the platform again, without changing anything. */
	public function handle_refresh(): void {
		$this->authorise();

		$result = $this->connection->refresh();

		$this->finish( $result['ok'], $result['message'] );
	}

	/** Revoke the connection. */
	public function handle_disconnect(): void {
		$this->authorise();

		$result = $this->connection->disconnect();

		$this->finish( $result['ok'], $result['message'] );
	}

	/**
	 * The capability and the nonce, in that order, for every handler.
	 *
	 * `check_admin_referer` dies with a 403 when the nonce is wrong or absent, which is the answer a forged request
	 * deserves; the capability check is separate because a valid nonce proves intent, not permission.
	 */
	private function authorise(): void {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You are not allowed to manage this store connection.', 'kd-payments' ), 403 );
		}

		check_admin_referer( self::NONCE_ACTION, self::NONCE_FIELD );
	}

	/**
	 * Leave a one-shot notice for the screen and go back to it.
	 *
	 * The message is stored for the current user only (a transient keyed by the user id), so one merchant's failure is
	 * never shown to another account on the same site.
	 *
	 * @param bool   $ok      Whether the action succeeded.
	 * @param string $message The sentence to show.
	 */
	private function finish( bool $ok, string $message ): void {
		set_transient(
			'kd_payments_notice_' . get_current_user_id(),
			array(
				'ok'      => $ok,
				'message' => $message,
			),
			60
		);

		wp_safe_redirect(
			add_query_arg(
				array( 'page' => self::PAGE_SLUG ),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}
}
