import { BlockList, isIP } from 'node:net';

export function normalizeIP(value) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) throw Error('Invalid IP address');
  if (isIP(value) === 4) return value;
  const address = new URL('http://[' + value + ']/').hostname.slice(1, -1);
  const mapped = address.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (mapped) {
    const n = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
    return [24, 16, 8, 0].map(bits => (n >>> bits) & 255).join('.');
  }
  return address;
}

// Only explicit IPs/CIDRs are trusted; never trust a caller-selected hop count.
export function clientAddressResolver(value = '') {
  const trusted = new BlockList();
  for (const item of value.split(',').map(s => s.trim()).filter(Boolean)) {
    const parts = item.split('/');
    if (parts.length > 2 || !isIP(parts[0]) || parts[0].includes('%')) throw Error('Invalid trusted proxy IP/CIDR');
    const family = isIP(parts[0]) === 4 ? 'ipv4' : 'ipv6';
    if (parts.length === 1) trusted.addAddress(parts[0], family);
    else {
      const bits = Number(parts[1]);
      if (!/^\d+$/.test(parts[1]) || !Number.isInteger(bits) || bits < 1 || bits > (family === 'ipv4' ? 32 : 128)) throw Error('Invalid trusted proxy prefix');
      trusted.addSubnet(parts[0], bits, family);
    }
  }
  const isTrusted = address => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return req => {
    const peer = normalizeIP(req.socket.remoteAddress);
    if (!isTrusted(peer)) return peer;
    const header = req.headers['x-forwarded-for'];
    if (header === undefined) return peer;
    if (typeof header !== 'string' || header.length > 2048) throw Object.assign(Error('Invalid forwarding header'), { status: 400 });
    const hops = header.split(',');
    if (hops.length > 32) throw Object.assign(Error('Too many proxy hops'), { status: 400 });
    let current = peer;
    for (let index = hops.length - 1; index >= 0 && isTrusted(current); index--) {
      try { current = normalizeIP(hops[index].trim()); }
      catch { throw Object.assign(Error('Invalid forwarding header'), { status: 400 }); }
    }
    return current;
  };
}
