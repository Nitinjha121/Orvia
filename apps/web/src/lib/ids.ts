/**
 * Every round and loop id is a Postgres uuid, so anything else in the address
 * bar cannot name one. Checked before fetching: the API answers a malformed id
 * with a validation message nobody should have to read.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (id: string) => UUID.test(id);
