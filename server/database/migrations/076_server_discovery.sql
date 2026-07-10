-- Public server discovery metadata. description/banner_url/category are owner-editable and
-- optional (a public server with no category shows only under "All"). verified/featured are
-- platform-admin flags (assignment UI lands in a later phase); both default off.
ALTER TABLE servers ADD COLUMN description TEXT;
ALTER TABLE servers ADD COLUMN banner_url TEXT;
ALTER TABLE servers ADD COLUMN category TEXT;
ALTER TABLE servers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
