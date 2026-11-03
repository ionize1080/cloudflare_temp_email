import { starterLinks } from '../public/defaults.mjs';
export async function initializeBookmarks(db, addressId) {
  if (await db.prepare('SELECT 1 FROM nav_bookmark_setup WHERE address_id=?').bind(addressId).first()) return;
  const initial = starterLinks.map((item, position) => ({ ...item, position, id: crypto.randomUUID() }));
  // One insert selects all defaults. The following marker commits atomically with it.
  // The predicates are checked again inside the transaction for concurrent first requests.
  await db.batch([
    db.prepare(`INSERT INTO nav_bookmarks(id,address_id,title,url,position)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.title'),json_extract(value,'$.url'),json_extract(value,'$.position')
      FROM json_each(?)
      WHERE NOT EXISTS(SELECT 1 FROM nav_bookmark_setup WHERE address_id=?)
      AND NOT EXISTS(SELECT 1 FROM nav_bookmarks WHERE address_id=?)`).bind(addressId,JSON.stringify(initial),addressId,addressId),
    db.prepare('INSERT OR IGNORE INTO nav_bookmark_setup(address_id) VALUES(?)').bind(addressId)
  ]);
}
