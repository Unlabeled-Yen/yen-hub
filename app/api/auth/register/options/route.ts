import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { RP_ID, RP_NAME, USER_ID, USER_NAME, USER_DISPLAY_NAME } from "@/lib/auth/config";
import { listPasskeys, setChallenge } from "@/lib/auth/passkeys";

export async function POST() {
  const existing = await listPasskeys();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: USER_NAME,
    userDisplayName: USER_DISPLAY_NAME,
    userID: new TextEncoder().encode(USER_ID),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.credentialID,
      transports: p.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      // Force Touch ID / Face ID (platform authenticator) — not USB keys.
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  await setChallenge(options.challenge);
  return NextResponse.json(options);
}

// Re-export this type alias to satisfy strict types above
type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";
