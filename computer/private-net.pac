// Chrome evaluates this for every request (Chrome's own resolver cache absorbs the lookup). Private, link-local,
// CGNAT and metadata addresses go to a dead proxy, so pages can't reach the host, other containers or cloud metadata.
// Checked after DNS, so a public name resolving to a private address is caught too. Loopback never reaches PAC
// (Chrome's implicit bypass), so the agent's own file server on 127.0.0.1 keeps working.
var DEAD = "PROXY 127.0.0.1:9";
// No ::ffff:0:0/96 here: isInNetEx matches every IPv4 address against it (measured: it dead-ended all sites).
var NETS = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4", "fc00::/7", "fe80::/10", "::/128"];
function privateIp(ip) {
  for (var i = 0; i < NETS.length; i++) if (isInNetEx(ip, NETS[i])) return true;
  return false;
}
function FindProxyForURL(url, host) {
  var h = host.replace(/^\[|\]$/g, "");
  if (/^metadata(\.google\.internal)?\.?$/i.test(h)) return DEAD;
  var literal = /^[0-9.]+$/.test(h) || h.indexOf(":") >= 0;
  var ips = literal ? h : dnsResolveEx(h);
  if (!ips) return "DIRECT";
  var list = ips.split(";");
  for (var i = 0; i < list.length; i++) if (list[i] && privateIp(list[i])) return DEAD;
  return "DIRECT";
}
