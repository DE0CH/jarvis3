import type { DeviceTokenIssuer, ServiceToken } from "../providers.ts";
import { randomId } from "../crypto.ts";

/** In-memory Cloudflare Access service tokens. */
export class FakeDeviceTokens implements DeviceTokenIssuer {
  readonly tokens = new Map<string, { name: string; clientId: string }>();
  readonly revoked: string[] = [];
  async mint(name: string): Promise<ServiceToken> {
    const t = { id: randomId(8), clientId: `${randomId(8)}.access`, clientSecret: randomId(16) };
    this.tokens.set(t.id, { name, clientId: t.clientId });
    return t;
  }
  async revoke(id: string): Promise<void> {
    this.tokens.delete(id);
    this.revoked.push(id);
  }
}
