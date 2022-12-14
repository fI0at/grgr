import Client from "../Client"
import { AccessLevel } from "../config";
import AbstractBoss from "../Entity/Boss/AbstractBoss";
import Defender from "../Entity/Boss/Defender";
import FallenBooster from "../Entity/Boss/FallenBooster";
import FallenOverlord from "../Entity/Boss/FallenOverlord";
import Guardian from "../Entity/Boss/Guardian";
import Summoner from "../Entity/Boss/Summoner";
import LivingEntity from "../Entity/Live";
import ArenaCloser from "../Entity/Misc/ArenaCloser";
import FallenAC from "../Entity/Misc/Boss/FallenAC";
import FallenSpike from "../Entity/Misc/Boss/FallenSpike";
import Dominator from "../Entity/Misc/Dominator";
import ObjectEntity from "../Entity/Object";
import AbstractShape from "../Entity/Shape/AbstractShape";
import Crasher from "../Entity/Shape/Crasher";
import Pentagon from "../Entity/Shape/Pentagon";
import Square from "../Entity/Shape/Square";
import Triangle from "../Entity/Shape/Triangle";
import AutoTurret from "../Entity/Tank/AutoTurret";
import Bullet from "../Entity/Tank/Projectile/Bullet";
import TankBody from "../Entity/Tank/TankBody";
import { Entity, EntityStateFlags } from "../Native/Entity";
import { saveToVLog } from "../util";
import { StyleFlags } from "./Enums";
import { getTankByName } from "./TankDefinitions"

export enum CommandID {
  gameSetTank = "settank",
  gameSetLevel = "setlevel",
  gameSetScore = "setscore",
  gameTeleport = "tp",
  gameClaim = "claim",
  adminGodmode = "god",
  adminSummon = "summon",
  adminKillAll = "ka",
  adminKillEntity = "kill",
  adminCloseArena = "close"
}

export interface CommandDefinition {
  id: CommandID,
  usage?: string,
  description?: string,
  permissionLevel: AccessLevel,
}

export interface CommandCallback {
  (client: Client, ...args: string[]): void
}

export const commandDefinitions = {
  settank: {
    id: CommandID.gameSetTank,
    usage: "[tank]",
    description: "Changes your tank to the given class",
    permissionLevel: AccessLevel.BetaAccess
  },
  setlevel: {
    id: CommandID.gameSetLevel,
    usage: "[level]",
    description: "Changes your level to the given whole number",
    permissionLevel: AccessLevel.BetaAccess
  },
  setscore: {
    id: CommandID.gameSetScore,
    usage: "[score]",
    description: "Changes your score to the given whole number",
    permissionLevel: AccessLevel.BetaAccess
  },
  tp: {
    id: CommandID.gameTeleport,
    usage: "[x] [y]",
    description: "Teleports you to the given position",
    permissionLevel: AccessLevel.BetaAccess
  },
  claim: {
    id: CommandID.gameClaim,
    usage: "[entityName]",
    description: "Attempts claiming an entity of the given type",
    permissionLevel: AccessLevel.BetaAccess
  },
  god: {
    id: CommandID.adminGodmode,
    description: "Toggles godmode",
    permissionLevel: AccessLevel.FullAccess
  },
  summon: {
    id: CommandID.adminSummon,
    usage: "[entityName] [?count] [?x] [?y]",
    description: "Spawns entities at a certain location",
    permissionLevel: AccessLevel.FullAccess
  },
  ka: {
    id: CommandID.adminKillAll,
    description: "Kills all entities in the arena",
    permissionLevel: AccessLevel.FullAccess
  },
  kill: {
    id: CommandID.adminKillEntity,
    usage: "[entityName]",
    description: "Kills all entities of the given type (might include self)",
    permissionLevel: AccessLevel.FullAccess
  },
  close: {
    id: CommandID.adminCloseArena,
    description: "Closes the current arena",
    permissionLevel: AccessLevel.FullAccess
  }
} as Record<CommandID, CommandDefinition>

export const commandCallbacks = {
  settank: (client: Client, tankNameArg: string) => {
    const tankDef = getTankByName(tankNameArg);
    const player = client.camera?.camera.player;
    if (!tankDef || !Entity.exists(player) || !(player instanceof TankBody)) return;
    player.setTank(tankDef.id);
  },
  setlevel: (client: Client, levelArg: string) => {
    const level = parseInt(levelArg);
    const player = client.camera?.camera.player;
    if (isNaN(level) || !Entity.exists(player) || !(player instanceof TankBody)) return;
    client.camera?.setLevel(level);
  },
  setscore: (client: Client, scoreArg: string) => {
    const score = parseInt(scoreArg);
    const camera = client.camera?.camera;
    const player = client.camera?.camera.player;
    if (isNaN(score) || score > Number.MAX_SAFE_INTEGER || score < Number.MIN_SAFE_INTEGER || !Entity.exists(player) || !(player instanceof TankBody) || !camera) return;
    camera.scorebar = score;
  },
  tp: (client: Client, xArg: string, yArg: string) => {
    const x = parseInt(xArg);
    const y = parseInt(yArg);
    const player = client.camera?.camera.player;
    if (isNaN(x) || isNaN(y) || !Entity.exists(player) || !(player instanceof TankBody)) return;
    player.position.x = x;
    player.position.y = y;
    player.setVelocity(0, 0);
    player.state |= EntityStateFlags.needsCreate | EntityStateFlags.needsDelete;
  },
  claim: (client: Client, entityArg: string) => {
    const TEntity = new Map([
      ["ArenaCloser", ArenaCloser],
      ["Dominator", Dominator],
      ["Shape", AbstractShape],
      ["Boss", AbstractBoss],
      ["AutoTurret", AutoTurret]
    ] as [string, typeof ObjectEntity][]).get(entityArg)

    if (!TEntity || !client.camera?.game.entities.AIs.length) return;

    const AIs = Array.from(client.camera.game.entities.AIs);
    for (let i = 0; i < AIs.length; ++i) {
      if (!(AIs[i].owner instanceof TEntity)) continue;
      client.possess(AIs[i]);
      return;
    }
  },
  god: (client: Client) => {
    if (client.camera?.camera.player?.style?.styleFlags) {
      if (client.camera.camera.player.style.styleFlags & StyleFlags.invincibility) {
        client.camera.camera.player.style.styleFlags ^= StyleFlags.invincibility;
      } else {
        client.camera.camera.player.style.styleFlags |= StyleFlags.invincibility;
      }
    }
  },
  summon: (client: Client, entityArg: string, countArg?: string, xArg?: string, yArg?: string) => {
    const count = countArg ? parseInt(countArg) : 1;
    const x = parseInt(xArg || "");
    const y = parseInt(yArg || "");
    const game = client.camera?.game;
    const TEntity = new Map([
      ["Defender", Defender],
      ["Summoner", Summoner],
      ["Guardian", Guardian],
      ["FallenOverlord", FallenOverlord],
      ["FallenBooster", FallenBooster],
      ["FallenAC", FallenAC],
      ["FallenSpike", FallenSpike],
      ["ac", ArenaCloser],
      ["Crasher", Crasher],
      ["Pentagon", Pentagon],
      ["Square", Square],
      ["Triangle", Triangle]
    ] as [string, typeof ObjectEntity][]).get(entityArg);

    if (isNaN(count) || count < 0 || !game || !TEntity) return;

    for (let i = 0; i < count; ++i) {
      const boss = new TEntity(game);
      if (!isNaN(x) && !isNaN(y)) {
        boss.position.x = x;
        boss.position.y = y;
      }
    }
  },
  ka: (client: Client) => {
    const game = client.camera?.game;
    if (!game) return;
    for (let id = 0; id <= game.entities.lastId; ++id) {
      const entity = game.entities.inner[id];
      if (Entity.exists(entity) && entity instanceof LivingEntity && entity !== client.camera?.camera.player) entity.health.health = 0;
    }
  },
  close: (client: Client) => {
    client?.camera?.game.arena.close();
  },
  kill: (client: Client, entityArg: string) => {
    const TEntity = new Map([
      ["ArenaCloser", ArenaCloser],
      ["Dominator", Dominator],
      ["Bullet", Bullet],
      ["Tank", TankBody],
      ["Shape", AbstractShape],
      ["Boss", AbstractBoss]
    ] as [string, typeof LivingEntity][]).get(entityArg);
    const game = client.camera?.game;
    if (!TEntity || !game) return;

    for (let id = 0; id <= game.entities.lastId; ++id) {
      const entity = game.entities.inner[id];
      if (Entity.exists(entity) && entity instanceof TEntity) entity.health.health = 0;
    }
  }
} as Record<CommandID, CommandCallback>

export const executeCommand = (client: Client, cmd: string, args: string[]) => {
  if (!commandDefinitions.hasOwnProperty(cmd) || !commandCallbacks.hasOwnProperty(cmd)) {
    return saveToVLog(`${client.toString()} tried to run the invalid command ${cmd}`);
  }

  if (client.accessLevel < commandDefinitions[cmd as CommandID].permissionLevel) {
    return saveToVLog(`${client.toString()} tried to run the command ${cmd} with a permission that was too low`);
  }

  commandCallbacks[cmd as CommandID](client, ...args);
}
