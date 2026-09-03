// Author: Liz
use zterm_lib::{models::ai::RiskLevel, services::ai_risk::classify_command};

#[test]
fn destructive_commands_are_high_or_critical_risk() {
    assert_eq!(classify_command("rm -rf /").risk_level, RiskLevel::Critical);
    assert_eq!(
        classify_command("rm -rf /tmp/demo").risk_level,
        RiskLevel::Critical
    );
    assert_eq!(
        classify_command("mkfs.ext4 /dev/sda").risk_level,
        RiskLevel::Critical
    );
    assert_eq!(
        classify_command("dd if=/dev/zero of=/dev/sda").risk_level,
        RiskLevel::Critical
    );
    assert_eq!(
        classify_command("userdel deploy").risk_level,
        RiskLevel::High
    );
    assert_eq!(
        classify_command("chmod -R 777 /var/www").risk_level,
        RiskLevel::High
    );
    assert_eq!(
        classify_command("systemctl stop sshd").risk_level,
        RiskLevel::High
    );
    assert_eq!(
        classify_command("ufw allow 0.0.0.0/0").risk_level,
        RiskLevel::High
    );
    assert_eq!(
        classify_command("netsh advfirewall firewall add rule name=open dir=in action=allow")
            .risk_level,
        RiskLevel::High
    );
    assert_eq!(
        classify_command("kubectl delete deployment api").risk_level,
        RiskLevel::High
    );
}

#[test]
fn read_only_commands_are_low_risk() {
    assert_eq!(classify_command("pwd").risk_level, RiskLevel::Low);
    assert_eq!(classify_command("ls -la").risk_level, RiskLevel::Low);
    assert_eq!(classify_command("whoami").risk_level, RiskLevel::Low);
}

#[test]
fn read_only_inventory_scripts_do_not_trigger_high_risk_from_labels_or_query_flags() {
    let script = r#"
printf '%s\n' '== service states =='
systemctl show sshd.service --no-pager -p ActiveState
command -v firewall-cmd >/dev/null && firewall-cmd --state
firewall-cmd --list-all
iptables -L -n
iptables -L -p tcp
"#;

    assert_eq!(classify_command(script).risk_level, RiskLevel::Medium);
}

#[test]
fn service_and_firewall_mutations_remain_high_risk() {
    for command in [
        "service nginx restart",
        "firewall-cmd --permanent --add-port=8443/tcp",
        "iptables -A INPUT -p tcp --dport 8443 -j ACCEPT",
        "iptables -P INPUT DROP",
    ] {
        assert_eq!(classify_command(command).risk_level, RiskLevel::High);
    }
}
