/** Runs once when the Inline server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Bring the Word copies on disk up to date with anything that changed while Inline was closed.
  const { mirror } = await import("@/lib/server/mirror");
  setTimeout(() => void mirror().sync(), 3000).unref?.();
}
