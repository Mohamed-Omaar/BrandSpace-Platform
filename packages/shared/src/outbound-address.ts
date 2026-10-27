/**
 * D-573 — WHERE THE PLATFORM MAY SEND A REQUEST ON ITS OWN BEHALF.
 *
 * An AI provider's `baseUrl` is configuration, so a wrong or malicious value
 * must not be able to point the platform's credentials at its own network:
 * the cloud metadata service, a database, an admin port. Two checks share these
 * rules: configuration validation refuses an unsafe URL before it is saved,
 * and the gateway's egress (`ai-gateway/src/egress.ts`) refuses an unsafe
 * ADDRESS after resolving the host, on every call, and connects to the address
 * it checked.
 *
 * PURE: no `node:` import, so this module is safe wherever `@brandspace/shared`
 * is bundled.
 */

/** Host names that only ever mean "this machine" or "this private network". */
const PRIVATE_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'lan',
  'home.arpa',
  'intranet',
] as const;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(address: string): number[] | null {
  const match = IPV4.exec(address);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function publicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(':')) return null;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  const v4 = ipv4Octets(tail);
  if (v4) {
    text = `${text.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${(
      (v4[2]! << 8) |
      v4[3]!
    ).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...rest,
  ];
  const values = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
  return values.length === 8 && values.every((value) => Number.isInteger(value)) ? values : null;
}

function publicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroTo = (index: number) => groups.slice(0, index).every((group) => group === 0);
  if (allZeroTo(8)) return false; // unspecified
  if (allZeroTo(7) && g7 === 1) return false; // loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the IPv4 inside.
  if (allZeroTo(5) && (g5 === 0xffff || g5 === 0)) {
    return publicIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  // NAT64 (64:ff9b::/96): the IPv4 inside decides.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard-only
  return true;
}

/** Is this text an IP address (v4, or v6 with or without brackets)? */
export function isIpAddressLiteral(host: string): boolean {
  return ipv4Octets(host) !== null || ipv6Groups(host) !== null;
}

/**
 * May the platform connect to this resolved ADDRESS? Only a public, routable
 * unicast address: never loopback, private, link-local (the cloud metadata
 * service lives there), carrier-grade NAT, multicast or documentation ranges.
 * Text that is not an address at all is refused.
 */
export function isPublicIpAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return publicIpv4(v4);
  const v6 = ipv6Groups(address);
  if (v6) return publicIpv6(v6);
  return false;
}

/** Why this host NAME may not be used, or null when it may. */
export function unsafeHostReason(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (name === '') return 'The host is empty.';
  if (isIpAddressLiteral(name)) {
    return 'Use the provider’s host name, not an IP address.';
  }
  if (!name.includes('.')) return 'Use a full host name (for example api.provider.com).';
  for (const suffix of PRIVATE_SUFFIXES) {
    if (name === suffix || name.endsWith(`.${suffix}`)) {
      return 'That host name only exists on a private network.';
    }
  }
  return null;
}

/** Why this URL may not be an AI provider's address, or null when it may. */
export function unsafeProviderUrlReason(value: string | undefined | null): string | null {
  if (!value) return 'The address is empty.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The address is not a valid URL.';
  }
  if (url.protocol !== 'https:') return 'The address must start with https://.';
  if (url.username || url.password) return 'The address must not contain a user name or password.';
  if (url.port !== '' && url.port !== '443') return 'The address must use the standard https port.';
  return unsafeHostReason(url.hostname);
}
