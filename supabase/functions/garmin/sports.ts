// Sporten uit Garmin Connect (typeKey) en uit .fit-bestanden (sport-nummer) -> categorie van het dagboek + Nederlandse naam.
// Categorieën: lopen, fietsen, zwemmen, kracht, andere. (Zelfde bestand staat ook bij de functie push.)
export type Cat = "lopen" | "fietsen" | "zwemmen" | "kracht" | "andere";
const NAMES: Record<string, string> = {
  SQUASH: "Squash", PADEL: "Padel", TENNIS: "Tennis", PICKLEBALL: "Pickleball", BADMINTON: "Badminton", TABLE_TENNIS: "Tafeltennis",
  RACQUETBALL: "Racquetball", PLATFORM_TENNIS: "Platformtennis", RACKET: "Racketsport", WALKING: "Wandelen", CASUAL_WALKING: "Wandelen",
  SPEED_WALKING: "Snelwandelen", HIKING: "Hiken", ROWING: "Roeien", INDOOR_ROWING: "Roeien (binnen)", ELLIPTICAL: "Crosstrainer",
  STAIR_CLIMBING: "Traplopen", FLOOR_CLIMBING: "Traplopen", SOCCER: "Voetbal", FOOTBALL: "Voetbal", BASKETBALL: "Basketbal",
  VOLLEYBALL: "Volleybal", HOCKEY: "Hockey", FIELD_HOCKEY: "Hockey", ICE_HOCKEY: "IJshockey", GOLF: "Golf", MULTI_SPORT: "Multisport",
  TRIATHLON: "Triatlon", DUATHLON: "Duatlon", RESORT_SKIING: "Skiën", RESORT_SKIING_SNOWBOARDING_WS: "Skiën", SKIING: "Skiën",
  BACKCOUNTRY_SKIING: "Toerskiën", CROSS_COUNTRY_SKIING: "Langlaufen", CROSS_COUNTRY_SKIING_WS: "Langlaufen", SNOWBOARDING: "Snowboarden",
  INLINE_SKATING: "Inline skaten", SKATING: "Schaatsen", ICE_SKATING: "Schaatsen", ROCK_CLIMBING: "Klimmen", INDOOR_CLIMBING: "Klimmen",
  BOULDERING: "Boulderen", MOUNTAINEERING: "Bergbeklimmen", BOXING: "Boksen", MIXED_MARTIAL_ARTS: "Vechtsport", DANCE: "Dansen",
  JUMP_ROPE: "Touwspringen", KAYAKING: "Kajakken", PADDLING: "Peddelen", STAND_UP_PADDLEBOARDING: "Suppen", SURFING: "Surfen",
  SAILING: "Zeilen", HORSEBACK_RIDING: "Paardrijden", YOGA: "Yoga", PILATES: "Pilates", HIIT: "HIIT", STRENGTH_TRAINING: "Kracht",
  INDOOR_CARDIO: "Cardio", FITNESS_EQUIPMENT: "Fitness", OTHER: "Andere sport",
};
const FITSPORT: Record<number, string> = {
  4: "FITNESS_EQUIPMENT", 6: "BASKETBALL", 7: "SOCCER", 8: "TENNIS", 10: "STRENGTH_TRAINING", 11: "WALKING", 12: "CROSS_COUNTRY_SKIING",
  13: "RESORT_SKIING", 14: "SNOWBOARDING", 15: "ROWING", 16: "MOUNTAINEERING", 17: "HIKING", 19: "PADDLING", 25: "GOLF",
  30: "INLINE_SKATING", 31: "ROCK_CLIMBING", 33: "ICE_SKATING", 37: "STAND_UP_PADDLEBOARDING", 38: "SURFING", 41: "KAYAKING",
  47: "BOXING", 62: "HIIT", 64: "RACKET", 73: "HOCKEY", 75: "VOLLEYBALL", 83: "DANCE", 84: "JUMP_ROPE",
};
export function sportOf(typeKey: unknown): [Cat, string] | null {
  const ty = String(typeKey ?? "").toUpperCase().trim();
  if (!ty || /MEDITATION|BREATHWORK|SLEEP|NAP/.test(ty)) return null;
  if (/SWIM/.test(ty)) return ["zwemmen", "Zwemmen"];
  if (/RUN/.test(ty)) return ["lopen", "Lopen"];
  if (/CYCL|BIK|RIDE|SPIN/.test(ty) && !/MOTOR/.test(ty)) return ["fietsen", "Fietsen"];
  const name = NAMES[ty] ?? ty.toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
  if (/STRENGTH|HIIT|INDOOR_CARDIO|FITNESS|YOGA|PILATES/.test(ty)) return ["kracht", name];
  return ["andere", name];
}
// .fit: sport-nummer (+ eventueel de naam van het sportprofiel op het horloge, bv. "Squash")
export function fitSportOf(n: number | undefined, profileName?: string, guess?: "lopen" | "fietsen"): [Cat, string] | null {
  if (n === 3 || n === 18 || n === 67) return null;                           // wissel, multisport-overkoepeling, meditatie
  if (n === 1) return ["lopen", "Lopen"];
  if (n === 2 || n === 21) return ["fietsen", "Fietsen"];
  if (n === 5) return ["zwemmen", "Zwemmen"];
  const nm = profileName && profileName.trim() ? profileName.trim().slice(0, 30) : null;
  if (n == null || n === 0) {
    if (nm) { const s = sportOf(nm.replace(/\s+/g, "_")); if (s && s[0] !== "andere") return s; return ["andere", nm]; }
    return guess ? [guess, guess === "fietsen" ? "Fietsen" : "Lopen"] : ["andere", "Andere sport"];
  }
  const s = sportOf(FITSPORT[n] ?? "OTHER")!;
  return nm && (s[0] === "andere" || s[0] === "kracht") ? [s[0], nm] : s;
}
