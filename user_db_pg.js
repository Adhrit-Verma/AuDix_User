import bcrypt from "bcrypt";

export function normalizeFlatId(x) {
  return String(x || "").trim().toUpperCase();
}

export async function createAccessRequest(query, { flat_id, name }) {
  const now = Date.now();
  flat_id = normalizeFlatId(flat_id);
  name = String(name || "").trim();
  if (!flat_id || !name) return { ok: false, error: "MISSING_FIELDS" };

  const existing = await query(
    `SELECT id, status FROM flat_requests
     WHERE flat_id = $1 AND status = 'PENDING'
     ORDER BY created_at DESC
     LIMIT 1`,
    [flat_id]
  );

  if (existing.rows[0]) {
    return { ok: true, id: existing.rows[0].id, status: existing.rows[0].status, reused: true };
  }

  const ins = await query(
    `INSERT INTO flat_requests (flat_id, name, note, status, created_at, updated_at)
     VALUES ($1,$2,'','PENDING',$3,$3)
     RETURNING id`,
    [flat_id, name, now]
  );

  return { ok: true, id: ins.rows[0].id, status: "PENDING", reused: false };
}

export async function setupPinWithCode(query, { flat_id, code, pin4, password }) {
  const now = Date.now();
  flat_id = normalizeFlatId(flat_id);

  if (!flat_id || !code || !pin4) return { ok: false, error: "MISSING_FIELDS" };
  if (!/^\d{4}$/.test(String(pin4))) return { ok: false, error: "PIN_MUST_BE_4_DIGITS" };

  const flatRes = await query(`SELECT * FROM flats WHERE flat_id = $1`, [flat_id]);
  const flat = flatRes.rows[0];
  if (!flat) return { ok: false, error: "FLAT_NOT_FOUND" };
  if (flat.status !== "ACTIVE") return { ok: false, error: "FLAT_DISABLED" };

  const rowsRes = await query(
    `SELECT id, code_hash, expires_at, used_at
     FROM setup_codes
     WHERE flat_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [flat_id]
  );

  const valid = rowsRes.rows.find((r) => !r.used_at && Number(r.expires_at) > now);
  if (!valid) return { ok: false, error: "NO_VALID_CODE" };

  const ok = await bcrypt.compare(String(code).trim(), valid.code_hash);
  if (!ok) return { ok: false, error: "INVALID_CODE" };

  const pin_hash = await bcrypt.hash(String(pin4), 10);
  const password_hash = password ? await bcrypt.hash(String(password), 10) : null;

  await query("BEGIN");
  try {
    await query(
      `UPDATE flats
       SET pin_hash=$1, password_hash=$2, updated_at=$3
       WHERE flat_id=$4`,
      [pin_hash, password_hash, now, flat_id]
    );

    await query(`UPDATE setup_codes SET used_at=$1 WHERE id=$2`, [now, valid.id]);
    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    throw e;
  }

  return { ok: true };
}

export async function loginFlat(query, { flat_id, pin4, password }) {
  const now = Date.now();
  flat_id = normalizeFlatId(flat_id);

  const flatRes = await query(`SELECT * FROM flats WHERE flat_id = $1`, [flat_id]);
  const flat = flatRes.rows[0];
  if (!flat) return { ok: false, error: "FLAT_NOT_FOUND" };
  if (flat.status !== "ACTIVE") return { ok: false, error: "FLAT_DISABLED" };

  if (flat.ban_until && Number(flat.ban_until) > now) return { ok: false, error: "BANNED", ban_until: flat.ban_until };
  if (flat.requires_admin_revoke) return { ok: false, error: "ADMIN_REVOKE_REQUIRED" };
  if (!flat.pin_hash) return { ok: false, error: "PIN_NOT_SET" };
  if (!/^\d{4}$/.test(String(pin4))) return { ok: false, error: "INVALID_PIN" };

  const pinOK = await bcrypt.compare(String(pin4), flat.pin_hash);
  if (!pinOK) return { ok: false, error: "INVALID_CREDENTIALS" };

  if (flat.password_hash) {
    if (!password) return { ok: false, error: "PASSWORD_REQUIRED" };
    const passOK = await bcrypt.compare(String(password), flat.password_hash);
    if (!passOK) return { ok: false, error: "INVALID_CREDENTIALS" };
  }

  await query(`UPDATE flats SET last_login_at=$1, updated_at=$1 WHERE flat_id=$2`, [now, flat_id]);
  return { ok: true, flat_id };
}

export async function getSetupStatus(query, { flat_id }) {
  const now = Date.now();
  flat_id = normalizeFlatId(flat_id);
  if (!flat_id) return { ok: false, error: "MISSING_FLAT_ID" };

  const reqRes = await query(
    `SELECT status, created_at, updated_at
     FROM flat_requests
     WHERE flat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [flat_id]
  );

  const flatRes = await query(
    `SELECT status, pin_hash, ban_until, requires_admin_revoke
     FROM flats
     WHERE flat_id = $1`,
    [flat_id]
  );

  const req = reqRes.rows[0] || null;
  const flat = flatRes.rows[0] || null;

  return {
    ok: true,
    flat_id,
    request: req ? { status: req.status, created_at: req.created_at, updated_at: req.updated_at } : null,
    flat: flat
      ? {
          status: flat.status,
          pinSet: !!flat.pin_hash,
          banned: !!(flat.ban_until && Number(flat.ban_until) > now),
          requiresAdminRevoke: !!flat.requires_admin_revoke
        }
      : null
  };
}
