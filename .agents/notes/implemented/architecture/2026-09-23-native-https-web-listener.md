# Agent Note: Native HTTPS on the Web listener

Status: implemented

English | [中文](2026-09-23-native-https-web-listener.zh.md)

## Problem

A directly reached Web listener needs to encrypt its traffic without requiring a separate reverse proxy. Advertising an HTTPS URL does not encrypt the listener or establish certificate trust.

## Decision

WebServer owns optional TLS through `tls: { certFile, keyFile }`, exposed by `dsh web` as paired `--tls-cert` and `--tls-key` flags. Certificate and unencrypted private-key PEM files are loaded before binding; unreadable, empty, invalid, or mismatched material fails activation without an HTTP fallback. HTTP remains the default. Both transports share routing, upgrades, and disposal; disposal also owns incomplete TLS handshakes.

`webServer.protocol` is the source for the bind-address URL and the non-loopback plain-HTTP warning. Neither forwarded headers nor `publicUrl` control encryption. Explicit Host-port grants normalize under the listener's scheme, while Origin comparison uses the Origin's HTTP(S) scheme so HTTPS proxies can retain HTTP upstreams. TLS grants no additional Host authority; the Host/Origin fence applies identically on both transports ([decision](2026-07-28-api-browser-trust-boundary.md)).

The API authority check does not equate a proxy's upstream transport with the browser page's scheme. An HTTPS listener can accept a matching HTTP Origin, but `sec-fetch-site: cross-site` still rejects the request. This is not support for serving a public browser frontend over HTTP with a TLS upstream.

Default ports follow URL normalization without a separate port-443 spelling.

Certificate issuance, trust, renewal, and replacement belong to the operator. Files are read once per activation; replacement requires a listener reload or process restart. The certificate must cover the hostname or IP the TLS client dials. The default port remains 3080; `--port` selects another port, subject to operating-system permission.

## Alternatives considered

**Require a TLS-terminating proxy.** This remains supported, but requires another service for a directly reached listener.

**Derive transport security from `publicUrl` or forwarding headers.** An advertisement does not describe the receiving socket, and request headers cannot establish trusted proxy identity. Native listener state keeps this decision independent of proxy policy.

**Issue, renew, or generate certificates.** This would add certificate lifecycle and trust-distribution responsibilities. An automatically generated certificate would not establish browser trust.

**Fall back to HTTP on certificate errors.** This would expose traffic despite an explicit request for encryption; activation must fail instead.

## Consequences

Direct HTTPS needs no TLS-terminating proxy. An HTTPS proxy in front of an HTTP listener still owns external transport encryption. Public browser-facing deployments must retain HTTPS so admitted traffic is not readable in transit ([reachability is the authority](2026-10-25-web-reachability-is-authority.md)). Deployment procedures belong to the [public deployments guide](../../../../docs/user/guide/public-deployments.md).

This partially supersedes the HTTP-only assumptions in [concrete bind addresses](2026-09-19-concrete-web-bind-address.md), which remains active for bind admission.

## Testing

The WebServer suite covers verified HTTPS, invalid material, and disposal. Connection covers exact-port grants; Web startup rejects unpaired flags. The built CLI's `public-url.expected.e2e.ts` serves over verified TLS while retaining HTTP and proxy cases; its failure matrix verifies unreadable TLS material exits without opening a listener. Desktop's startup suite covers matching WS/WSS scheme derivation and refusal on a different transport.
