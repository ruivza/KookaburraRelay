import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
// Operator-supplied hosts (alert webhooks, custom S3 endpoints) must not lead
// outbound requests to loopback, private, link-local or other internal ranges.
export const isPublicAddress=address=>ipaddr.isValid(address)&&ipaddr.process(address).range()==='unicast';
export function requirePublic(addresses,message){
  if(!addresses.length||addresses.some(({address})=>!isPublicAddress(address)))throw Error(message);
  return addresses;
}
// A net.connect lookup that checks every resolved address and connects only to
// those, so a second DNS answer cannot swap in an internal address.
export function publicLookup(message,resolver=dnsLookup){
  return (hostname,options,callback)=>{
    resolver(hostname,{...options,all:true}).then(addresses=>requirePublic(addresses,message)).then(addresses=>{
      const family=({address,family})=>family||isIP(address);
      if(options.all)callback(null,addresses.map(entry=>({address:entry.address,family:family(entry)})));
      else callback(null,addresses[0].address,family(addresses[0]));
    },callback);
  };
}
