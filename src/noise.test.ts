import { test } from "node:test";
import assert from "node:assert/strict";

import { NoiseInitiator, requestHash } from "./noise.js";

// Produced by the Python `noiseprotocol` package (the library synology-api
// uses for this login) with the same fixed keys on both sides.
const VECTOR = {
  initiatorStatic: "0101010101010101010101010101010101010101010101010101010101010101",
  initiatorEphemeral: "0202020202020202020202020202020202020202020202020202020202020202",
  responderStatic: "5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22",
  payload: "{\"time\": 1700000000}",
  message1:
    "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59067cf7be2bbd2098cca8cfa1902fe6de60a78362f04eedb3fb1789b2c570e6c5bcb10d48e5e0c8eecd4447e55f8ab63c0bd56929540f86bf72197b807842ea92f9931d491c9df9597eb1b4b5271744e166212e5e",
  message2: "ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10b8b073c6a29a99cb15898860192554ff7",
  handshakeHash:
    "7a97977fd997454e4237dfd35a16fe89b721e2b95f709403bbbb44c183bbed9cde0c991f99cbbc0b177841360f775ac3d216331035cebb073a59102a0a541b38",
  nonce: 123456789n,
  requestHash: "epeXf9mXmI3aMsJxhHOMeMK9fsWNtw.MTIzNDU2Nzg5",
};

test("the Noise IK initiator matches an independent implementation", () => {
  const hex = (s: string) => Buffer.from(s, "hex");
  const initiator = new NoiseInitiator(hex(VECTOR.responderStatic), Buffer.from(VECTOR.payload), {
    s: hex(VECTOR.initiatorStatic),
    e: hex(VECTOR.initiatorEphemeral),
  });
  assert.equal(initiator.message1.toString("hex"), VECTOR.message1);
  const session = initiator.finish(hex(VECTOR.message2));
  assert.equal(session.handshakeHash.toString("hex"), VECTOR.handshakeHash);
  assert.equal(requestHash(session, VECTOR.nonce), VECTOR.requestHash);
});
