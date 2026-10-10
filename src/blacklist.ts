/** One person on the API's permanent-ban list, with every id they may appear under (LID, phone number...). */
export interface BlacklistEntry {
    user_ids: string[]
    name?: string | null
}

/** A group member as the sweep needs it: the JID the group knows them by, plus every id they can appear under. */
export interface SweepMember {
    jid: string
    ids: string[]
}

/** The members of a group that are on the blacklist, matched by ANY of their ids (the group may know someone by
 * their LID while the list kept their phone number, or the other way round). */
export function findBlacklisted(members: SweepMember[], blacklist: BlacklistEntry[]): SweepMember[] {
    const banned = new Set(blacklist.flatMap((entry) => entry.user_ids))
    if (banned.size === 0) return []
    return members.filter((member) => member.ids.some((id) => banned.has(id)))
}
