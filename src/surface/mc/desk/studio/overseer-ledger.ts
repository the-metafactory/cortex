import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { STUDIO_SLUG } from "./format";
import type { StudioFile } from "./view";

export const THEME_LEDGER_PATH = ".studio-overseer-themes.json";
const ThemeRecord = z.object({ proposal: z.string().regex(STUDIO_SLUG), captures: z.array(z.string().regex(STUDIO_SLUG)).min(3) }).strict();
const Ledger = z.object({ version: z.literal(1), themes: z.array(ThemeRecord) }).strict();
export type ThemeLedger = z.infer<typeof Ledger>;
export interface ThemeLedgerSnapshot { text: string | null; value: ThemeLedger }

export async function readThemeLedger(dir: string): Promise<ThemeLedgerSnapshot> {
 const path=join(dir,THEME_LEDGER_PATH);
 try {
  const info=await lstat(path);
  if(!info.isFile()||info.size>1_000_000||await realpath(path)!==path)throw new Error("Studio theme provenance must be a regular file inside Studio and at most one megabyte");
  const text=await readFile(path,"utf8");
  return {text,value:Ledger.parse(JSON.parse(text))};
 }catch(error){
  if(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")return {text:null,value:{version:1,themes:[]}};
  throw error;
 }
}

export function proposalProvenance(files: StudioFile[], ledger: ThemeLedger): ThemeLedger {
 const themes=[...ledger.themes];
 for(const file of files){
  const proposal=file.path.slice("proposals/".length).replace(/\.md$/,"");
  if(!/^theme-[a-f0-9]{20}$/.test(proposal)||themes.some(theme=>theme.proposal===proposal))continue;
  const captures:string[]=[];const pattern=/^- Inbox capture: ([a-z0-9][a-z0-9-]{0,79})\r?$/gm;
  let match:RegExpExecArray|null;
  while((match=pattern.exec(file.text))!==null)if(match[1]&&!captures.includes(match[1]))captures.push(match[1]);
  if(captures.length>=3)themes.push({proposal,captures});
 }
 return {version:1,themes};
}
