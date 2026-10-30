// Composable world builders for the backend harness (addendum-081, F4).
// `ctx.world` gives keyed, idempotent steps: re-invoking a key returns the
// existing row instead of creating a duplicate. Under the hood these wrap the
// existing fixture builders (helpers.tsx) — the discipline (real DB, no
// mocks) is unchanged, this is just declarative intent.
import {
  createAdmin,
  createActiveUser,
  createCluster,
  createTeam,
  addMember,
  mapTeamToSystem,
  createSingleStepAgencySystem,
  uniqueEmail,
} from "../helpers.tsx";
import type {
  User, Cluster, Team, System, TeamMembership,
} from "../../../../server/types.tsx";

export class WorldBuilder {
  private store = new Map<string, unknown>();

  private get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  private set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  // Admin with full_admin grant. Same key → same user.
  async admin(key = "admin", password = "WorldAdmin!2026"): Promise<User> {
    const k = `admin:${key}`;
    const existing = this.get<User>(k);
    if (existing) return existing;
    const u = await createAdmin(password);
    this.set(k, u);
    return u;
  }

  // Active user (already 2FA-enrolled by the fixture builder).
  async user(key: string, opts: { affiliation: "agency" | "vendor"; password?: string }): Promise<User> {
    const k = `user:${key}`;
    const existing = this.get<User>(k);
    if (existing) return existing;
    const u = await createActiveUser({
      fullName: `World User ${key}`,
      email: uniqueEmail(`world-${key}`),
      password: opts.password ?? "WorldUser!2026",
      affiliation: opts.affiliation,
    });
    this.set(k, u);
    return u;
  }

  // Cluster. Same key → same cluster.
  async cluster(key: string, type: "vendor" | "agency" | "pa", createdBy: string): Promise<Cluster> {
    const k = `cluster:${key}`;
    const existing = this.get<Cluster>(k);
    if (existing) return existing;
    const c = await createCluster(type, createdBy);
    this.set(k, c);
    return c;
  }

  // Team under a previously-built cluster.
  async team(key: string, clusterKey: string, level: number, createdBy: string): Promise<Team> {
    const k = `team:${key}`;
    const existing = this.get<Team>(k);
    if (existing) return existing;
    const cluster = this.get<Cluster>(`cluster:${clusterKey}`);
    if (!cluster) throw new Error(`world.team: cluster '${clusterKey}' not built yet`);
    const t = await createTeam(cluster, level, createdBy);
    this.set(k, t);
    return t;
  }

  // Membership of a built user in a built team.
  async member(teamKey: string, userKey: string, addedBy: string, role: "member" | "team_admin" = "member"): Promise<TeamMembership> {
    const k = `member:${teamKey}:${userKey}`;
    const existing = this.get<TeamMembership>(k);
    if (existing) return existing;
    const team = this.get<Team>(`team:${teamKey}`);
    const user = this.get<User>(`user:${userKey}`);
    if (!team) throw new Error(`world.member: team '${teamKey}' not built yet`);
    if (!user) throw new Error(`world.member: user '${userKey}' not built yet`);
    const m = await addMember(team, user, addedBy, role);
    this.set(k, m);
    return m;
  }

  // A fully-wired, submittable system (submitter vendor L1 → agency L1) with
  // its clusters/teams/mappings/owner. Returns the whole topology.
  async singleStepSystem(key: string, createdBy: string, ownerUser: User): Promise<{
    system: System; vendorCluster: Cluster; agencyCluster: Cluster; vendorL1: Team; agencyL1: Team;
  }> {
    const k = `system:${key}`;
    const existing = this.get<{ system: System; vendorCluster: Cluster; agencyCluster: Cluster; vendorL1: Team; agencyL1: Team }>(k);
    if (existing) return existing;
    const built = await createSingleStepAgencySystem(createdBy, ownerUser);
    this.set(k, built);
    // Also register its clusters/teams under default keys so later steps can
    // reference them without rebuilding.
    this.set(`cluster:${key}-vendor`, built.vendorCluster);
    this.set(`cluster:${key}-agency`, built.agencyCluster);
    this.set(`team:${key}-vendorL1`, built.vendorL1);
    this.set(`team:${key}-agencyL1`, built.agencyL1);
    return built;
  }

  // Map a built team to a built system.
  async mapTeamToSystem(teamKey: string, systemKey: string, createdBy: string): Promise<void> {
    const team = this.get<Team>(`team:${teamKey}`);
    const sys = this.get<{ system: System }>(`system:${systemKey}`);
    if (!team) throw new Error(`world.mapTeamToSystem: team '${teamKey}' not built`);
    if (!sys) throw new Error(`world.mapTeamToSystem: system '${systemKey}' not built`);
    await mapTeamToSystem(team, sys.system, createdBy);
  }
}
