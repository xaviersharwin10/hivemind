#[test_only]
module hivemind::registry_tests;

use hivemind::registry::{Self, Registry, Group};
use std::string;
use sui::clock;
use sui::test_scenario as ts;

const OWNER: address = @0xA11CE;
const BOT: address = @0xB07;
const STRANGER: address = @0xBAD;

fun acct_id(): ID {
    // A throwaway object id to stand in for a MemWalAccount.
    object::id_from_address(@0xACC0)
}

#[test]
fun registers_and_records_artifact() {
    let mut sc = ts::begin(OWNER);
    registry::init_for_testing(sc.ctx());

    // Owner registers the group, authorizing BOT as the writer.
    sc.next_tx(OWNER);
    let mut reg = sc.take_shared<Registry>();
    let clk = clock::create_for_testing(sc.ctx());
    registry::register_group(
        &mut reg,
        string::utf8(b"-100200300"),
        acct_id(),
        string::utf8(b"main"),
        BOT,
        &clk,
        sc.ctx(),
    );
    assert!(registry::is_registered(&reg, string::utf8(b"-100200300")), 0);
    ts::return_shared(reg);

    // BOT (the writer) appends an artifact.
    sc.next_tx(BOT);
    let mut group = sc.take_shared<Group>();
    assert!(registry::artifact_count(&group) == 0, 1);
    registry::record_artifact(
        &mut group,
        string::utf8(b"blob_abc"),
        string::utf8(b"spec.pdf"),
        string::utf8(b"application/pdf"),
        x"deadbeef",
        true,
        &clk,
        sc.ctx(),
    );
    assert!(registry::artifact_count(&group) == 1, 2);
    let a = vector::borrow(registry::artifacts(&group), 0);
    assert!(registry::artifact_blob_id(a) == string::utf8(b"blob_abc"), 3);
    assert!(registry::artifact_sealed(a), 4);
    ts::return_shared(group);

    clock::destroy_for_testing(clk);
    sc.end();
}

#[test]
#[expected_failure(abort_code = registry::ENotAuthorized)]
fun stranger_cannot_record() {
    let mut sc = ts::begin(OWNER);
    registry::init_for_testing(sc.ctx());

    sc.next_tx(OWNER);
    let mut reg = sc.take_shared<Registry>();
    let clk = clock::create_for_testing(sc.ctx());
    registry::register_group(
        &mut reg,
        string::utf8(b"-1"),
        acct_id(),
        string::utf8(b"main"),
        BOT,
        &clk,
        sc.ctx(),
    );
    ts::return_shared(reg);

    // A stranger (neither owner nor writer) must be rejected.
    sc.next_tx(STRANGER);
    let mut group = sc.take_shared<Group>();
    registry::record_artifact(
        &mut group,
        string::utf8(b"x"),
        string::utf8(b"x"),
        string::utf8(b"text/plain"),
        x"00",
        false,
        &clk,
        sc.ctx(),
    );
    ts::return_shared(group);
    clock::destroy_for_testing(clk);
    sc.end();
}
