// Slice 2+ CLI commands (act, settle, watch). Registered here so cli/disco.ts stays a thin switch.
export async function run(cmd: string, _pos: string[], _flags: Record<string, string | boolean>, ctx: { die: (m: string) => never }): Promise<void> {
  ctx.die(`command "${cmd}" is not implemented yet (Slice 2)`);
}
