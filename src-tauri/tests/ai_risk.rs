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
