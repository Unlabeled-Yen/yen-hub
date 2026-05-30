import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { RP_ID } from "@/lib/auth/config";
import { listPasskeys, setChallenge } from "@/lib/auth/passkeys";

type AuthenticatorTransportFuture =
  | "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export async function POST() {
  const passkeys = await listPasskeys();
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialID,
      transports: p.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "preferred",
  });
  await setChallenge(options.challenge);
  return NextResponse.json(options);
}
