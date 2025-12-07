use spectrum_lib::collect_all_au_state_counts;

#[test]
fn test_collect_all_instance_states_runs() {
    // This test ensures collect_all_instance_states() can be invoked without crashing.
    // It may return 0 if no instances are present, which is acceptable.
    let count = collect_all_au_state_counts();
    println!("collect_all_instance_states returned {} entries", count);
    // Always succeed if it returns (no panic).
}
