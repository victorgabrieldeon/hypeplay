/**
 * The ICE servers the PS2 games' WebRTC uses: public STUN always (the page's own defaults) and, when the server has
 * one, a TURN relay for players whose networks can't reach each other directly. The TURN credential is coturn's REST
 * kind (--use-auth-secret): "<expiry>:<user>" signed with the shared secret, good for 12 h like the pass.
 */
import { createHmac } from "node:crypto";

export const STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const TURN_TTL_S = 12 * 60 * 60;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export function iceServers({ turnUrl, turnSecret, user, now }: { turnUrl?: string; turnSecret?: string; user: string; now: number }): IceServer[] {
  const servers: IceServer[] = [{ urls: STUN }];
  if (turnUrl && turnSecret) {
    const username = `${Math.floor(now / 1000) + TURN_TTL_S}:${user}`;
    // (a plain turn: address by UDP and by TCP: some networks only let TCP through; one that says its own, as it is)
    const urls = /^turn:[^?]+$/.test(turnUrl) ? [`${turnUrl}?transport=udp`, `${turnUrl}?transport=tcp`] : turnUrl;
    servers.push({ urls, username, credential: createHmac("sha1", turnSecret).update(username).digest("base64") });
  }
  return servers;
}
