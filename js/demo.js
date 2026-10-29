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
    { id: "q1", household_id: "h1", owner_id: me, name: "Work", kind: "work", address: "101 Collins St, Melbourne", show_on_cards: true, latitude: -37.81489, longitude: 144.97064, geocode_status: "ok", position: 1 },
    { id: "q2", household_id: "h1", owner_id: me, name: "Gym", kind: "gym", address: "Fitness First, 380 Sydney Rd, Brunswick", show_on_cards: false, latitude: -37.76881, longitude: 144.96126, geocode_status: "ok", position: 2 },
    { id: "q3", household_id: "h1", owner_id: partner, name: "Work", kind: "work", address: "Box Hill Hospital", show_on_cards: true, latitude: -37.81361, longitude: 145.11841, geocode_status: "ok", position: 3 },
    { id: "q4", household_id: "h1", owner_id: partner, name: "Uni", kind: "study", address: "Main campus", show_on_cards: false, latitude: null, longitude: null, geocode_status: "not_found", position: 4 },
    { id: "q5", household_id: "h1", owner_id: null, name: "Groceries", kind: "shops", address: "Coles, Barkly Square, Brunswick", show_on_cards: false, latitude: -37.77275, longitude: 144.96063, geocode_status: "ok", position: 5 },
    { id: "q6", household_id: "h1", owner_id: null, name: "Mum and Dad", kind: "family", address: "Ivanhoe", show_on_cards: false, latitude: -37.76889, longitude: 145.04500, geocode_status: "approximate", position: 6 }
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
  const stops = {
    p1: [{ kind: "train", name: "Anstey", stop_no: null, walk_s: 682, distance_m: 853 }, { kind: "tram", name: "Albion St/Melville Rd", stop_no: "37", walk_s: 697, distance_m: 872 }],
    p2: [{ kind: "train", name: "Jewell", stop_no: null, walk_s: 480, distance_m: 600 }, { kind: "tram", name: "Brunswick Rd/Sydney Rd", stop_no: "19", walk_s: 150, distance_m: 190 }],
    p4: [{ kind: "train", name: "Coburg", stop_no: null, walk_s: 540, distance_m: 690 }, { kind: "tram", name: "Bell St/Sydney Rd", stop_no: "39", walk_s: 300, distance_m: 380 }],
    p5: [{ kind: "tram", name: "Lygon St/Queensberry St", stop_no: "1", walk_s: 240, distance_m: 310 }]
  };
  for (const p of props) if (stops[p.id]) p.nearest_stops = stops[p.id];
  const map = (rows) => new Map(rows.map((r) => [r.id, r]));
  return {
    user: { id: me, email: "matthewjhuang@gmail.com" },
    household,
    members: [
      { household_id: "h1", user_id: me, display_name: "Matthew", email: "matthewjhuang@gmail.com", reminder_lead_minutes: 60 },
      { household_id: "h1", user_id: partner, display_name: "Hannah", email: "hannahhuange@gmail.com", reminder_lead_minutes: 60 }
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
