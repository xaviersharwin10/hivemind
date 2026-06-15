/// HiveMind on-chain registry.
///
/// HiveMind turns a group chat into a verifiable, portable AI memory. The *memory*
/// (text) and *files* live in MemWal + Walrus; this module is the on-chain index
/// that makes them verifiable and portable instead of trapped in a backend:
///
///   - `Registry`  — a shared singleton mapping a chat id to its `Group`.
///   - `Group`     — one group's on-chain record: which `MemWalAccount` its memory
///                   lives under, who owns it, which key may append, and a
///                   tamper-evident **manifest of every artifact** shared in the
///                   group (Walrus blob id + a SHA-256 integrity anchor).
///
/// Anyone can now resolve a group from its chat id, read the full artifact list,
/// and verify that a Walrus blob matches the hash the group committed on-chain —
/// without trusting HiveMind's servers.
module hivemind::registry;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// === Errors ===

/// A group is already registered for this chat id.
const EGroupExists: u64 = 0;
/// Caller is neither the group owner nor its authorized writer.
const ENotAuthorized: u64 = 1;
/// Caller is not the group owner.
const ENotOwner: u64 = 2;

// === Objects ===

/// Shared singleton. Resolves a chat id to its `Group` object id.
public struct Registry has key {
    id: UID,
    groups: Table<String, ID>,
}

/// One HiveMind group's on-chain record (shared so the bot, members, and any
/// verifier can read it; appends are authorized in `record_artifact`).
public struct Group has key {
    id: UID,
    /// Opaque chat identifier (e.g. a Telegram chat id as text).
    chat_id: String,
    /// The creator's address (zkLogin identity). Owns the group.
    owner: address,
    /// Address allowed to append artifacts — the group's bot delegate.
    writer: address,
    /// The `MemWalAccount` object id this group's memories are written under.
    memwal_account: ID,
    /// Memory namespace within that account.
    namespace: String,
    /// Tamper-evident manifest of every artifact shared in the group.
    artifacts: vector<Artifact>,
    created_at_ms: u64,
}

/// One shared file, anchored on-chain. `sha256` lets anyone verify the bytes
/// fetched from Walrus are exactly what the group committed.
public struct Artifact has store, copy, drop {
    /// Walrus blob id holding the bytes.
    blob_id: String,
    name: String,
    mime: String,
    /// SHA-256 of the stored bytes (the Seal ciphertext when `sealed`).
    sha256: vector<u8>,
    /// True if the bytes on Walrus are Seal-encrypted.
    sealed: bool,
    added_by: address,
    added_at_ms: u64,
}

// === Events ===

public struct GroupRegistered has copy, drop {
    group: ID,
    chat_id: String,
    owner: address,
    memwal_account: ID,
}

public struct ArtifactRecorded has copy, drop {
    group: ID,
    blob_id: String,
    name: String,
    sealed: bool,
    added_by: address,
}

// === Init ===

/// Publish-time: create and share the singleton registry.
fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry {
        id: object::new(ctx),
        groups: table::new(ctx),
    });
}

#[test_only]
/// Test-only: run `init` against a test scenario's context.
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

// === Entry functions ===

/// Register a group. Called by the creator (owner-signed, gas-sponsored) at
/// onboarding, right after their `MemWalAccount` is created. Aborts if this chat
/// is already registered.
public fun register_group(
    registry: &mut Registry,
    chat_id: String,
    memwal_account: ID,
    namespace: String,
    writer: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!registry.groups.contains(chat_id), EGroupExists);
    let owner = ctx.sender();
    let group = Group {
        id: object::new(ctx),
        chat_id,
        owner,
        writer,
        memwal_account,
        namespace,
        artifacts: vector[],
        created_at_ms: clock.timestamp_ms(),
    };
    let gid = object::id(&group);
    registry.groups.add(chat_id, gid);
    event::emit(GroupRegistered { group: gid, chat_id, owner, memwal_account });
    transfer::share_object(group);
}

/// Append an artifact to a group's on-chain manifest. Authorized for the group's
/// owner or its registered writer (the bot delegate) — both sign gas-sponsored.
public fun record_artifact(
    group: &mut Group,
    blob_id: String,
    name: String,
    mime: String,
    sha256: vector<u8>,
    sealed: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == group.writer || sender == group.owner, ENotAuthorized);
    group.artifacts.push_back(Artifact {
        blob_id,
        name,
        mime,
        sha256,
        sealed,
        added_by: sender,
        added_at_ms: clock.timestamp_ms(),
    });
    event::emit(ArtifactRecorded {
        group: object::id(group),
        blob_id,
        name,
        sealed,
        added_by: sender,
    });
}

/// Owner-only: rotate the address allowed to append artifacts.
public fun set_writer(group: &mut Group, writer: address, ctx: &TxContext) {
    assert!(ctx.sender() == group.owner, ENotOwner);
    group.writer = writer;
}

// === Read-only accessors ===

/// The `Group` object id registered for a chat id, if any.
public fun group_id_for(registry: &Registry, chat_id: String): Option<ID> {
    if (registry.groups.contains(chat_id)) {
        option::some(*registry.groups.borrow(chat_id))
    } else {
        option::none()
    }
}

public fun is_registered(registry: &Registry, chat_id: String): bool {
    registry.groups.contains(chat_id)
}

public fun owner(group: &Group): address { group.owner }

public fun writer(group: &Group): address { group.writer }

public fun memwal_account(group: &Group): ID { group.memwal_account }

public fun namespace(group: &Group): String { group.namespace }

public fun artifact_count(group: &Group): u64 { group.artifacts.length() }

public fun artifacts(group: &Group): &vector<Artifact> { &group.artifacts }

public fun artifact_blob_id(a: &Artifact): String { a.blob_id }

public fun artifact_sha256(a: &Artifact): vector<u8> { a.sha256 }

public fun artifact_sealed(a: &Artifact): bool { a.sealed }
