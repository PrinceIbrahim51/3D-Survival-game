// Constants shared by the authoritative server and the browser client.
// Anything that affects simulation results MUST live here so that client-side
// prediction and the server agree.

export const TICK_RATE = 30; // server simulation ticks per second
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
export const INPUT_DT = 1 / 60; // fixed step of one client input command

export const WORLD_SIZE = 360; // metres, square map centred on the origin
export const WORLD_HALF = WORLD_SIZE / 2;
export const WORLD_MARGIN = 3; // players are clamped this far inside the edge
export const SEA_LEVEL = 0;
export const SWIM_DEPTH = 1.3; // how deep a swimming player sits below sea level

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.2;
export const EYE_HEIGHT = 1.6;
export const CROUCH_EYE_HEIGHT = 1.05;
export const STEP_HEIGHT = 0.45;
export const MANTLE_REACH = 1.25; // holding jump against an obstacle whose top is this close pulls you up
export const MANTLE_SPEED = 5.5;

export const GRAVITY = 22;
export const JUMP_SPEED = 7;
export const WALK_SPEED = 5.2;
export const SPRINT_SPEED = 7.6;
export const CROUCH_SPEED = 2.6;
export const ADS_SPEED = 3.2;
export const SWIM_SPEED = 3.0;
export const GROUND_ACCEL = 60;
export const AIR_ACCEL = 14;

export const CHUTE_ALTITUDE = 75; // metres above ground at deployment
export const CHUTE_SPEED = 13;
export const CHUTE_ACCEL = 18;
export const CHUTE_FALL = 9;

export const MAX_HP = 100;
// Team modes: a player whose health runs out is knocked down instead of
// eliminated while a team-mate is still standing.
export const DOWN_HP = 100;
export const BLEED_SECONDS = 35; // time a downed player lasts without help
export const REVIVE_SECONDS = 4;
export const REVIVE_HP = 30;
export const REVIVE_RANGE = 2.4;
export const PICKUP_RADIUS = 1.5; // automatic pickup range
export const INTERACT_RADIUS = 2.6; // manual pickup range
export const INTERP_DELAY_MS = 100; // how far in the past remote players are drawn
export const MAX_REWIND_MS = 400; // lag-compensation limit
// Players further away than this are not sent to a client at all (team-mates
// always are). It saves bandwidth in big matches and gives a modified client
// less to reveal.
export const RELEVANCY_RADIUS = 230;

// Input button bit flags.
export const BTN = {
  JUMP: 1,
  SPRINT: 2,
  CROUCH: 4,
  ADS: 8,
  FIRE: 16,
  RELOAD: 32,
};
export const BTN_MASK = 63;

// Bit flags describing a player in snapshots.
export const PF = {
  GROUND: 1,
  CROUCH: 2,
  CHUTE: 4,
  ADS: 8,
  SPRINT: 16,
  RELOAD: 32,
  HEAL: 64,
  VEHICLE: 128,
  DOWN: 256,
};

export function eyeHeight(crouch) {
  return crouch ? CROUCH_EYE_HEIGHT : EYE_HEIGHT;
}

// View direction for yaw/pitch. yaw 0 looks down -Z, positive yaw turns left,
// positive pitch looks up.
export function dirFromAngles(yaw, pitch, out = {}) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}
