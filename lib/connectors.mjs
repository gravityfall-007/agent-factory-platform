/**
 * Remote MCP connector URL policy.
 *
 * Connector URLs must be public HTTPS endpoints: no credentials, query
 * strings, fragments, localhost, private networks, or metadata addresses.
 * The DNS lookup is injectable so tests never touch the network.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./core.mjs";

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && [0, 2, 168].includes(b)) return false;
    if (a === 198 && [18, 19, 51].includes(b)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return false;
    if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return false;
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice("::ffff:".length));
    return value.startsWith("2") || value.startsWith("3") || (value.startsWith("2001:") && !value.startsWith("2001:db8:"));
  }
  return false;
}

export function createConnectorValidator({ lookup = dnsLookup } = {}) {
  return async function validateConnectorUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, "Connector URL must be a valid HTTPS URL.");
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      throw new HttpError(400, "Connector URL must use HTTPS and omit credentials, query strings, and fragments.");
    }
    const literal = isIP(host);
    const addresses = literal ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new HttpError(400, "Connector URL must resolve only to public IP addresses.");
    }
    return url.toString();
  };
}
