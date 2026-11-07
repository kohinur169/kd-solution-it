<?php
// path: plugins/woocommerce/kd-payments/kd-payments.php

/**
 * Plugin Name:       KD Payments for WooCommerce
 * Plugin URI:        https://kdsolution.example.com/woocommerce
 * Description:       Connects this WooCommerce store to the KD Solutions platform. A merchant logs in with an API key and the connection becomes active automatically.
 * Version:           1.0.0
 * Requires at least: 6.2
 * Requires PHP:      8.1
 * Author:            KD Solutions
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       kd-payments
 * Domain Path:       /languages
 * WC requires at least: 7.0
 * WC tested up to:   9.0
 *
 * The plugin is deliberately thin: it holds the merchant's API key and the store's own token, it asks the platform to
 * activate the connection, and it shows what the platform answered. Everything that decides money - payments,
 * captures, refunds - happens on the platform, which is why this package never sees a card and never computes a total.
 */

// A PHP file that runs because somebody requested it directly is a vulnerability; every entry point checks this.
defined( 'ABSPATH' ) || exit;

define( 'KD_PAYMENTS_VERSION', '1.0.0' );
define( 'KD_PAYMENTS_PLUGIN_FILE', __FILE__ );
define( 'KD_PAYMENTS_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-api-client.php';
require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-connection.php';
require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-settings.php';

/**
 * The address of the platform's public API.
 *
 * Filterable so a staging store can be pointed at a staging platform, and https by default because a credential travels
 * on every call. The filter exists for developers; a merchant never sees it.
 */
function kd_payments_api_base(): string {
	$base = apply_filters( 'kd_payments_api_base', 'https://app.kdsolution.example.com' );

	return is_string( $base ) && '' !== $base ? untrailingslashit( $base ) : '';
}

/**
 * Boot the plugin once WooCommerce is known to be present.
 *
 * Without WooCommerce there is nothing to connect, and saying so in the admin notice is better than a fatal error on
 * activation.
 */
function kd_payments_boot(): void {
	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action( 'admin_notices', 'kd_payments_woocommerce_missing_notice' );

		return;
	}

	$connection = new KD_Connection();
	$settings   = new KD_Settings( $connection );

	$settings->register();
}
add_action( 'plugins_loaded', 'kd_payments_boot' );

/** The notice a site without WooCommerce sees instead of a broken plugin. */
function kd_payments_woocommerce_missing_notice(): void {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}

	printf(
		'<div class="notice notice-error"><p>%s</p></div>',
		esc_html__( 'KD Payments needs WooCommerce to be installed and active.', 'kd-payments' )
	);
}

/**
 * Activation writes the two options this plugin owns, with autoload off.
 *
 * The API key and the store token are secrets: an autoloaded option is loaded on every page of the site, which is the
 * one place a secret should never be.
 */
function kd_payments_activate(): void {
	if ( false === get_option( 'kd_payments_store_token', false ) ) {
		// Thirty-two random bytes, hex encoded: the token the platform will present to this store on every call it makes.
		add_option( 'kd_payments_store_token', bin2hex( random_bytes( 32 ) ), '', 'no' );
	}

	add_option( 'kd_payments_api_key', '', '', 'no' );
	add_option( 'kd_payments_connection', array(), '', 'no' );
}
register_activation_hook( __FILE__, 'kd_payments_activate' );

/** Deactivation forgets nothing: a merchant who deactivates a plugin has not disconnected a store. */
function kd_payments_deactivate(): void {
	delete_transient( 'kd_payments_status' );

	if ( function_exists( 'get_current_user_id' ) ) {
		delete_transient( 'kd_payments_notice_' . get_current_user_id() );
	}
}
register_deactivation_hook( __FILE__, 'kd_payments_deactivate' );
