// Deletes every sheet on the Collection board. Run it before the sheet take:
// a sheet left by an earlier take shows its claims on the new one as foreign.
import { signIn } from '../../../e2e/src/session.ts';
import { BOARD, EMAIL, PASSWORD } from './lib.ts';

const s = await signIn(EMAIL, PASSWORD);
const sheets = await s.get<{ id: string }[]>(`/boards/${BOARD}/sheets`);
for (const sheet of sheets.json)
  console.log('delete', sheet.id, (await s.del(`/sheets/${sheet.id}`)).status);
