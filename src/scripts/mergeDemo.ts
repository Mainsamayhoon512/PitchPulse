import { prisma } from "../db";
import { players } from "../sync/entities";
import { normalizePlayer } from "../sync/normalize";

const TEST_PID = 999001;
const TEST_NAME = "Merge Demo Player";
let failed = 0;

function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}

async function cleanup() {
  const rows = await prisma.player.findMany({ where: { title: TEST_NAME } });
  for (const r of rows) {
    await prisma.changeLog.deleteMany({ where: { entity: "Player", entityId: r.id } });
    await prisma.player.delete({ where: { id: r.id } });
  }
}

async function main() {
  await cleanup();

  // 1. An admin creates a player by hand and locks one field.
  const admin = await prisma.player.create({
    data: {
      title: TEST_NAME,
      birthdate: new Date("1990-01-01T00:00:00Z"),
      country: "in",
      battingStyle: "Left Hand Bat",
      birthplace: "Admin City",
      bio: "Written by admin",
      lockedFields: ["battingStyle"],
      createdBy: "ADMIN",
    },
  });

  // 2. The provider later sends the same player, with some empty and some junk values.
  const incoming = normalizePlayer({
    pid: TEST_PID,
    title: TEST_NAME,
    birthdate: "1990-01-01",
    birthplace: "",
    country: "in",
    playing_role: "all",
    batting_style: "Right Hand Bat",
    bowling_style: "Right Arm Fast",
    twitter_profile: " @notaurl ",
  });
  if (!incoming) throw new Error("normalizePlayer returned null");

  const first = await players.upsert(incoming);
  const after = await prisma.player.findUniqueOrThrow({ where: { id: admin.id } });

  check("provider record linked to the admin player (same row)", first.id === admin.id && first.action === "linked");
  check("providerId was set", after.providerId === TEST_PID);
  check("provider overwrote an unlocked field (playingRole)", after.playingRole === "all");
  check("locked field kept (battingStyle)", after.battingStyle === "Left Hand Bat");
  check("empty provider value did not blank admin data (birthplace)", after.birthplace === "Admin City");
  check("admin-only field untouched (bio)", after.bio === "Written by admin");
  check("junk social value dropped (twitterUrl)", after.twitterUrl === null);
  const logs = await prisma.changeLog.count({ where: { entity: "Player", entityId: admin.id } });
  check("changes written to the audit log", logs >= 2);

  const second = await players.upsert(incoming);
  check("running the same sync again changes nothing", second.action === "unchanged");
  check("no duplicate rows", (await prisma.player.count({ where: { title: TEST_NAME } })) === 1);

  await cleanup();
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());