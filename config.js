// Verbinding met de database. De publishable key is bedoeld om openbaar te zijn;
// de beveiliging zit in de privacyregels (Row Level Security) van de database.
// Zet hier NOOIT de secret/service_role key.
window.TD_CONFIG = {
  url: "https://ckpizktozroqaxfoqwpy.supabase.co",   // bv. https://abcdefgh.supabase.co
  key: "sb_publishable_lN4HeQzIORdgdyksWWSTYA_UlU2unAA",   // de publishable key (sb_publishable_...) of de anon key
  club: "Legati Triteam",
  mail: false,  // true zodra er een eigen mailserver (SMTP) is ingesteld: dan werkt "wachtwoord vergeten"
  garmin: false, // true zodra Garmin de club-app goedkeurde en de sleutels als geheimen in Supabase staan
  garminKey: true // leden kunnen koppelen met hun persoonlijke Garmin-sleutel (Garmin Connect Personal API)
};
