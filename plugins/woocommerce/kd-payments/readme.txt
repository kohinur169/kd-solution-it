=== KD Payments for WooCommerce ===
Contributors: kdsolutions
Tags: payments, woocommerce, gateway, api
Requires at least: 6.2
Requires PHP: 8.1
Tested up to: 6.6
WC requires at least: 7.0
WC tested up to: 9.0
Stable tag: 1.0.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connects a WooCommerce store to the KD Solutions platform. The merchant logs in with an API key and the connection
becomes active automatically.

== Description ==

This plugin is the WooCommerce half of the platform's store connection. It does three things and nothing else:

1. It keeps the merchant's **public API key**, written by the merchant on the plugin's settings screen. The key is
   stored unautoloaded, is never shown again and is never sent anywhere but the platform over HTTPS.
2. It generates a **store token** on activation, on this server, with `random_bytes`. The platform seals that token and
   presents it on the calls it makes to this store later; the store therefore never has to receive a secret to trust one.
3. It asks the platform to **activate** the connection, shows the status the platform answered, and can refresh it or
   revoke it.

The store's domain is read from the site itself rather than typed, so a merchant cannot connect a shop that is not this
one.

== Installation ==

1. Upload the `kd-payments` folder to `/wp-content/plugins/`, or install the zip through Plugins → Add New.
2. Activate the plugin through the Plugins screen.
3. On the platform, open Developers → API credentials and create a key for this store's mode (test or live).
4. In WooCommerce → KD Payments, paste the key, save it, then press **Connect**.

The connection becomes active immediately: the platform authenticates the key, records the store against the merchant
and answers the connection. No approval step exists.

== Frequently Asked Questions ==

= What happens to my orders if I disconnect? =

Nothing. Disconnecting revokes the platform's access to this store; the platform keeps its own record of the payments it
already handled. A revoked connection cannot be reactivated - installing again after a disconnect is a support action.

= Can I use a test key? =

Yes. A test key connects the store the same way and lets the whole checkout be exercised against the platform's sandbox
without moving money. Payments carry their own mode, which is the key's mode.

= Where is the API key stored? =

In this site's options table, in the row `kd_payments_api_key`, with autoload off. It is never printed on a screen and
never written to a log.

== Changelog ==

= 1.0.0 =
* First release: the connection screen, the login, refresh and disconnect.
