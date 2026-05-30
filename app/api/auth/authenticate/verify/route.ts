import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { ORIGIN, RP_ID, USER_ID } from "@/lib/auth/config";
import { consumeChallenge, findPasskey, updatePasskeyCounter } from "@/lib/auth/passkeys";
import { getSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const challenge = await consumeChallenge();
  if (!challenge) {
    return NextResponse.json({ ok: false, error: "no_challenge" }, { status: 400 });
  }

  const passkey = await findPasskey(body.id);
  if (!passkey) {
    return NextResponse.json({ ok: false, error: "unknown_credential" }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credentialID,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
        counter: passkey.counter,
        transports: passkey.transports as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[] | undefined,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "verify_failed", message: (e as Error).message },
      { status: 400 },
    );
  }

  if (!verification.verified) {
    return NextResponse.json({ ok: false, error: "not_verified" }, { status: 400 });
  }

  await updatePasskeyCounter(passkey.credentialID, verification.authenticationInfo.newCounter);

  const session = await getSession();
  session.userId = USER_ID;
  session.authenticatedAt = Date.now();
  await session.save();

  return NextResponse.json({ ok: true });
}
