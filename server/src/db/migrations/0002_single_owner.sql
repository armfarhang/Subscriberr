-- M2: there is exactly one Owner (Spec §3). The sign-in code creates the owner inside a
-- transaction; this index makes a second owner impossible even under a race.
CREATE UNIQUE INDEX accounts_single_owner_uq ON accounts (role) WHERE role = 'owner';
