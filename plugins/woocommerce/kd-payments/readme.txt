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

This plugin is the WooCommerce half of the platform's store connection, its payment method and its callback. It does
five things and nothing else:

1. It keeps the merchant's **public API key**, written by the merchant on the plugin's settings screen. The key is
   stored unautoloaded, is never shown again and is never sent anywhere but the platform over HTTPS.
2. It generates a **store token** on activation, on this server, with `random_bytes`. The platform seals that token and
   presents it on the calls it makes to this store later; the store therefore never has to receive a secret to trust one.
3. It asks the platform to **activate** the connection, shows the status the platform answered, and can refresh it or
   revoke it.
4. It adds a **payment method at checkout** that creates the payment on the platform for the order's total, records the
   payment's id on the order and puts the order on hold. No card data reaches this plugin or this server.
5. It answers the platform's **callback** at `/?wc-api=kd_payments_callback`, verifies the store token in constant time,
   asks the platform for the payment's real status, and then moves the order. A redelivered callback changes nothing.

The store's domain is read from the site itself rather than typed, so a merchant cannot connect a shop that is not this
one. The shop must live at the root of its domain: the platform derives the callback address from the domain alone, so a
WordPress installed under a subdirectory answers at a different address and the handshake says so instead of connecting a
shop no callback could reach. The gateway is available only when the store is connected, the key is saved and the shop trades in USD - the one
currency the platform's public API accepts - because a silent conversion is a wrong amount on a real customer's card.

== Installation ==

1. Upload the `kd-payments` folder to `/wp-content/plugins/`, or install the zip through Plugins → Add New.
2. Activate the plugin through the Plugins screen.
3. On the platform, open Developers → API credentials and create a key for this store's mode (test or live).
4. In WooCommerce → KD Payments, paste the key, save it, then press **Connect**.

The connection becomes active immediately: the platform authenticates the key, records the store against the merchant
and answers the connection. No approval step exists.

== The callback ==

The platform calls `https://{your shop}/?wc-api=kd_payments_callback` with the store token as a bearer credential and a
small JSON body naming the payment. This plugin:

* compares the token with `hash_equals` before reading the body;
* refuses a body that is not exactly the platform's six-key envelope, or is larger than 64 KB;
* finds the order through the payment id it stored at checkout, never through anything the body names;
* asks the platform - server to server, with your API key - what the payment's status really is, and applies that, not
  what the body claims;
* records the callback id on the order, so the same callback twice changes nothing.

A callback the shop missed can be made up by hand: **Check the payment with KD Payments**, in WooCommerce's own order
actions, reads that order's payment from the platform and applies it through the same code path.

If the platform cannot be reached the endpoint answers `503`, which asks the platform to try again. If no order matches
the payment it answers `200` with `handled: false`, so the platform does not retry a callback this shop can never use.

**Send a test callback** on the plugin's screen asks the platform to call this shop about the newest payment it created,
so a merchant can see the whole round trip - the request, the store token, the platform's own status read and the answer -
without waiting for a real payment. It never marks an order paid.

== Frequently Asked Questions ==

= What happens to my orders if I disconnect? =

Nothing. Disconnecting revokes the platform's access to this store; the platform keeps its own record of the payments it
already handled. A revoked connection cannot be reactivated - installing again after a disconnect is a support action.

= Can I use a test key? =

Yes. A test key connects the store the same way and lets the whole checkout be exercised against the platform's sandbox
without moving money. Payments carry their own mode, which is the key's mode.

= What happens if a callback is missed? =

The order stays on hold, and nothing moves it until the platform is asked again. Open the order in WooCommerce, choose
**Check the payment with KD Payments** from the order actions and apply it: the plugin asks the platform about that
order's payment - the id it stored at checkout, never one typed by hand - and applies the answer exactly as a callback
would. The result is a note on the order either way, doing it twice changes nothing, and if the platform cannot be
reached the order is left as it is rather than guessed at.

= Where is the API key stored? =

In this site's options table, in the row `kd_payments_api_key`, with autoload off. It is never printed on a screen and
never written to a log.

== Changelog ==

= 1.0.0 =
* First release: the connection screen, the login, refresh and disconnect.
* The checkout gateway: a payment created on the platform, the order on hold until the platform confirms.
* The callback endpoint: the store token in constant time, the platform re-read, the order moved once.
