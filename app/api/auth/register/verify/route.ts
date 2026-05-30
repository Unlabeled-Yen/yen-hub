import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { ORIGIN, RP_ID, USER_ID } from "@/lib/auth/config";
import { addPasskey, consumeChallenge } from "@/lib/auth/passkeys";
import { getSession } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const challenge = await consumeChallenge();
  if (!challenge) {
    return NextResponse.json({ ok: false, error: "no_challenge" }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "verify_failed", message: (e as Error).message },
      { status: 400 },
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ ok: false, error: "not_verified" }, { status: 400 });
  }

  const { credential } = verification.registrationInfo;

  await addPasskey({
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: credential.transports,
    createdAt: Date.now(),
    label: "Mac Touch ID",
  });

  // Auto-login after successful registration
  const session = await getSession();
  session.userId = USER_ID;
  session.authenticatedAt = Date.now();
  await session.save();

  return NextResponse.json({ ok: true });
}
