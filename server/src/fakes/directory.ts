import type { DirectoryProvider, DirectoryUser } from "../providers.ts";

/** A directory the test edits directly. */
export class FakeDirectory implements DirectoryProvider {
  users: DirectoryUser[] = [];
  fail: string | null = null;
  async listUsers(): Promise<DirectoryUser[]> {
    if (this.fail) throw new Error(this.fail);
    return this.users.map((u) => ({ ...u, groups: [...u.groups] }));
  }
  set(email: string, patch: Partial<DirectoryUser>): void {
    const e = email.toLowerCase();
    const i = this.users.findIndex((u) => u.email === e);
    if (i === -1) this.users.push({ email: e, name: "", suspended: false, groups: [], ...patch });
    else this.users[i] = { ...this.users[i]!, ...patch };
  }
  remove(email: string): void {
    this.users = this.users.filter((u) => u.email !== email.toLowerCase());
  }
}
