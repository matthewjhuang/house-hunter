// Sample data for http://localhost:5501/#demo — lets you click through every screen
// without signing in. Nothing here is saved; writes stay in memory.
export function demoData() {
  const me = "00000000-0000-4000-8000-000000000001";
  const partner = "00000000-0000-4000-8000-000000000002";
  const household = { id: "h1", name: "Matthew & Hannah", max_rent_pw: 700 };
  const day = (d, h, m = 0) => {
    const t = new Date();
    t.setDate(t.getDate() + d);
    t.setHours(h, m, 0, 0);
    return t.toISOString();
  };
  const base = { household_id: "h1", state: "VIC", listing_status: "active", parse_status: "ok", missing_fields: [], has_unseen_changes: false, sources: [], photo_urls: [], rejected_reason: null, rejected_note: null, rejected_from_stage: null };
  const props = [
    { ...base, id: "p1", latitude: -37.76074, longitude: 144.95317, stage: "saved", position: 5, address: "48 Fraser Street", suburb: "Brunswick", postcode: "3056", rent_pw: 850, bond: 3693, beds: 3, baths: 1, cars: 1, property_type: "House", available_date: "2026-10-30",
      agent_name: "Amelie Frere", agency: "Jellis Craig Northcote", agent_phone: "0421 132 535", agent_email: "agent@example.com",
      description: "Three bedrooms, one bathroom and a layout that works.\nNorth-facing yard.",
      photo_urls: ["https://rimh2.domainstatic.com.au/FtNySsux3zgDCFkRd-bj3-QlYa0=/fit-in/1920x1080/filters:format(webp):quality(85):no_upscale()/18381742_1_1_261022_024753-w1620-h1080"],
      sources: [{ site: "domain.com.au", url: "https://www.domain.com.au/48-fraser-street-brunswick-vic-3056-18381742", listing_id: "18381742" }, { site: "realestate.com.au", url: "https://www.realestate.com.au/property-house-vic-brunswick-000000", listing_id: null }] },
    { ...base, id: "p2", latitude: -37.76705, longitude: 144.95883, stage: "saved", position: 4, address: "1/463 Brunswick Road", suburb: "Brunswick", postcode: "3056", rent_pw: 420, bond: 1825, beds: 1, baths: 1, cars: 1, property_type: "Apartment / Unit / Flat", available_date: "2026-10-13",
      agent_name: "Ben Gill", agency: "Jellis Craig Northcote", has_unseen_changes: true,
      photo_urls: ["https://rimh2.domainstatic.com.au/DGZEPgN1UOLd1PYIhVS8lRZxnp4=/fit-in/1920x1080/filters:format(webp):quality(85):no_upscale()/18366096_1_1_261013_062622-w1800-h1200", "https://example.invalid/broken.jpg"],
      sources: [{ site: "domain.com.au", url: "https://www.domain.com.au/1-463-brunswick-road-brunswick-vic-3056-18366096", listing_id: "18366096" }] },
    { ...base, id: "p3", stage: "saved", position: 3, address: null, suburb: null, title: "Listing on realestate.com.au", parse_status: "blocked",
      missing_fields: ["address", "rent_pw", "beds", "baths", "cars", "available_date", "bond", "agent_name", "photo_urls"],
      sources: [{ site: "realestate.com.au", url: "https://www.realestate.com.au/property-unit-vic-coburg-000001", listing_id: null }] },
    { ...base, id: "p4", latitude: -37.74405, longitude: 144.96402, stage: "inspection_booked", position: 2, address: "7 Hope Street", suburb: "Coburg", postcode: "3058", rent_pw: 640, beds: 2, baths: 1, cars: 0, photo_urls: ["https://example.invalid/missing.jpg"] },
    { ...base, id: "p5", latitude: -37.80303, longitude: 144.96693, stage: "applied", position: 1, address: "22/5 Lygon Street", suburb: "Carlton", postcode: "3053", rent_pw: 610, beds: 2, baths: 2, cars: 1, listing_status: "under_application", has_unseen_changes: true },
    { ...base, id: "p6", stage: "rejected", position: 1, address: "9 Albert Street", suburb: "Preston", postcode: "3072", rent_pw: 560, beds: 2, baths: 1, cars: 1, rejected_reason: "condition", rejected_note: "Mould in the second bedroom", rejected_from_stage: "inspected" }
  ];
  const inspections = [
    { id: "i1", household_id: "h1", property_id: "p1", starts_at: day(2, 11, 50), ends_at: day(2, 12, 5), booked: false, origin: "parsed" },
    { id: "i2", household_id: "h1", property_id: "p4", starts_at: day(1, 17, 30), ends_at: day(1, 17, 45), booked: true, origin: "manual" }
  ];
  const comments = [
    { id: "c1", household_id: "h1", property_id: "p1", author_id: partner, body: "Love the yard. Bit far from the 96 tram though.", created_at: day(-1, 19) },
    { id: "c2", household_id: "h1", property_id: "p1", author_id: me, body: "Agreed — worth a look on Saturday?", created_at: day(0, 8) }
  ];
  const labels = ["Water pressure", "Mould and damp", "Natural light", "Noise", "Heating and cooling", "Storage", "Phone reception", "Kitchen condition", "Bathroom condition", "Security", "Parking"];
  const checklist = props.flatMap((p) => labels.map((label, i) => ({ id: `${p.id}-ck${i}`, household_id: "h1", property_id: p.id, label, position: i + 1, rating: p.id === "p1" && i < 3 ? ["good", "okay", "bad"][i] : null, note: p.id === "p1" && i === 1 ? "Some marks on the bathroom ceiling" : null, is_custom: false })));
  const changes = [
    { id: "x1", household_id: "h1", property_id: "p2", kind: "price", old_value: "$450/wk", new_value: "$420/wk", detected_at: day(0, 6) },
    { id: "x2", household_id: "h1", property_id: "p5", kind: "status", old_value: "Available", new_value: "Under application", detected_at: day(0, 6) }
  ];
  const placeRows = [
    { id: "q1", household_id: "h1", owner_id: me, name: "Work", kind: "work", address: "101 Collins St, Melbourne", travel_mode: "drive", show_on_cards: true, latitude: -37.81489, longitude: 144.97064, geocode_status: "ok", position: 1 },
    { id: "q2", household_id: "h1", owner_id: me, name: "Gym", kind: "gym", address: "Fitness First, 380 Sydney Rd, Brunswick", travel_mode: "drive", show_on_cards: false, latitude: -37.76881, longitude: 144.96126, geocode_status: "ok", position: 2 },
    { id: "q3", household_id: "h1", owner_id: partner, name: "Work", kind: "work", address: "Box Hill Hospital", travel_mode: "transit", show_on_cards: true, latitude: -37.81361, longitude: 145.11841, geocode_status: "ok", position: 3 },
    { id: "q4", household_id: "h1", owner_id: partner, name: "GP", kind: "health", address: "Medical centre", travel_mode: "transit", show_on_cards: false, latitude: null, longitude: null, geocode_status: "not_found", position: 4 },
    { id: "q5", household_id: "h1", owner_id: null, name: "Groceries", kind: "shops", address: "Coles, Barkly Square, Brunswick", travel_mode: "transit", show_on_cards: false, latitude: -37.77275, longitude: 144.96063, geocode_status: "ok", position: 5 },
    { id: "q6", household_id: "h1", owner_id: null, name: "Mum and Dad", kind: "family", address: "Ivanhoe", travel_mode: "transit", show_on_cards: false, latitude: -37.76889, longitude: 145.04500, geocode_status: "approximate", position: 6 }
  ];
  // Rough times from straight-line distance, so the numbers look plausible.
  const km = (a, b) => Math.hypot((a.latitude - b.latitude) * 111, (a.longitude - b.longitude) * 88);
  const summaries = ["Upfield line", "Tram 19", "Upfield line, 1 change", "Tram 96, 1 change", "Mernda line, 2 changes"];
  const travel = [];
  for (const p of props.filter((x) => x.latitude && x.stage !== "rejected")) {
    for (const q of placeRows.filter((x) => x.latitude)) {
      const d = km(p, q);
      travel.push({ id: `${p.id}-${q.id}-t`, household_id: "h1", property_id: p.id, place_id: q.id, mode: "transit", status: "ok",
        duration_s: Math.round((8 + d * 3.1) * 60), summary: d < 1.2 ? "Walk" : summaries[(p.id.charCodeAt(1) + q.id.charCodeAt(1)) % summaries.length],
        manual_s: p.id === "p1" && q.id === "q5" ? 540 : null, computed_at: day(-1, 3) });
      travel.push({ id: `${p.id}-${q.id}-d`, household_id: "h1", property_id: p.id, place_id: q.id, mode: "drive", status: "ok",
        duration_s: Math.round((4 + d * 2.3) * 60), distance_m: Math.round(d * 1300), manual_s: null, computed_at: day(-1, 3) });
    }
  }
  // Public transport near each listing: lines, how often they run at 8am and the last
  // service home, with stops a plausible walk away.
  const at = (h, i) => new Date(Date.UTC(2026, 10, 18, h - 11, i)).toISOString();
  const lineSets = {
    p1: [
      { mode: "train", route: "Upfield", stop: "Anstey", walk: 11, dirs: [["Flinders Street via City Loop", true, 6, at(24, 2)], ["Upfield", false, 6, at(24, 41)]] },
      { mode: "tram", route: "19", stop: "Albion St/Sydney Rd", no: "26", walk: 9, dirs: [["Flinders Street", true, 12, at(24, 31)], ["North Coburg", false, 11, at(25, 12)]] },
      { mode: "tram", route: "58", stop: "Albion St/Melville Rd", no: "37", walk: 12, dirs: [["Toorak", true, 8, at(23, 58)], ["West Coburg", false, 7, at(24, 44)]] },
      { mode: "bus", route: "503", stop: "Patterson St/Albion St", walk: 4, dirs: [["Essendon", false, 4, at(21, 20)], ["East Brunswick", false, 4, at(21, 5)]] }
    ],
    p2: [
      { mode: "train", route: "Upfield", stop: "Jewell", walk: 8, dirs: [["Flinders Street via City Loop", true, 6, at(24, 4)], ["Upfield", false, 6, at(24, 39)]] },
      { mode: "tram", route: "19", stop: "Brunswick Rd/Sydney Rd", no: "19", walk: 3, dirs: [["Flinders Street", true, 12, at(24, 35)], ["North Coburg", false, 11, at(25, 8)]] }
    ],
    p4: [
      { mode: "train", route: "Upfield", stop: "Coburg", walk: 9, dirs: [["Flinders Street via City Loop", true, 6, at(23, 55)], ["Upfield", false, 6, at(24, 48)]] },
      { mode: "tram", route: "19", stop: "Bell St/Sydney Rd", no: "39", walk: 5, dirs: [["Flinders Street", true, 12, at(24, 25)], ["North Coburg", false, 11, at(25, 18)]] }
    ],
    p5: [
      { mode: "tram", route: "1", stop: "Lygon St/Queensberry St", no: "1", walk: 4, dirs: [["South Melbourne Beach", true, 10, at(24, 40)], ["East Coburg", false, 9, at(25, 2)]] },
      { mode: "tram", route: "6", stop: "Lygon St/Queensberry St", no: "1", walk: 4, dirs: [["Glen Iris", true, 10, at(24, 50)], ["Moreland", false, 9, at(25, 14)]] }
    ]
  };
  for (const p of props) {
    const set = lineSets[p.id];
    if (!set) continue;
    p.transit = {
      version: "2026-11-12",
      lines: set.map((l, i) => ({
        mode: l.mode, route: l.route, walk_s: l.walk * 60, distance_m: l.walk * 80,
        stop: { name: l.stop, no: l.no ?? null,
          lat: p.latitude + Math.sin(1 + i * 1.9) * l.walk * 70 / 111000, lon: p.longitude + Math.cos(1 + i * 1.9) * l.walk * 70 / 88000 },
        dirs: l.dirs.map(([to, city, peak, last]) => ({ to, city, peak, last }))
      }))
    };
  }
  // Nearby: the closest of each store and a park, spread around each listing.
  const nearbyKinds = [["coles", "Coles"], ["woolworths", "Woolworths Metro"], ["aldi", "Aldi"], ["chemist_warehouse", "Chemist Warehouse"], ["park", "Gilpin Park"]];
  props.filter((p) => p.latitude && p.stage !== "rejected").forEach((p, n) => {
    p.nearby = {
      version: "2026-11-01",
      items: nearbyKinds.map(([kind, name], i) => {
        const walk = [11, 6, 24, 9, 4][(i + n) % 5] * 60;
        const angle = (i + n) * 1.3;
        return { kind, name, lat: p.latitude + Math.sin(angle) * walk * 1.1 / 111000, lon: p.longitude + Math.cos(angle) * walk * 1.1 / 88000,
          distance_m: Math.round(walk * 1.3), walk_s: walk, drive_s: Math.round(walk / 4), ...(kind === "park" ? { ha: 4.2 } : {}) };
      })
    };
  });
  const map = (rows) => new Map(rows.map((r) => [r.id, r]));
  return {
    user: { id: me, email: "matthewjhuang@gmail.com" },
    household,
    members: [
      { household_id: "h1", user_id: me, display_name: "Matthew", email: "matthewjhuang@gmail.com", reminder_lead_minutes: 60, travel_mode: "drive" },
      { household_id: "h1", user_id: partner, display_name: "Hannah", email: "hannahhuange@gmail.com", reminder_lead_minutes: 60, travel_mode: "transit" }
    ],
    invites: [],
    properties: map(props),
    inspections: map(inspections),
    comments: map(comments),
    checklist: map(checklist),
    changes: map(changes),
    places: map(placeRows),
    travel: map(travel)
  };
}
