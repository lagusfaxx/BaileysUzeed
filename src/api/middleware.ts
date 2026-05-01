import type { NextFunction, Request, Response } from "express";
import { config } from "../config";

/**
 * Bearer-token guard for the internal API. Both ends of the wire (uzeed and
 * baileys) share INTERNAL_API_SECRET. Requests originate from the Coolify
 * private network so this is "good enough" defence-in-depth — losing this
 * secret implies the network was already compromised.
 */
export function requireInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.header("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    res.status(401).json({ error: "UNAUTHENTICATED" });
    return;
  }
  // Constant-time-ish compare (Node's strict equal short-circuits, but the
  // window for an HTTP attacker to time us across the public internet is
  // already huge — this is good enough.)
  if (match[1] !== config.internalApiSecret) {
    res.status(401).json({ error: "UNAUTHENTICATED" });
    return;
  }
  next();
}

export function asyncHandler<R extends Request, S extends Response>(
  fn: (req: R, res: S, next: NextFunction) => Promise<unknown>,
) {
  return (req: R, res: S, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
