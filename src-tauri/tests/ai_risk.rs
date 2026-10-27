// Author: Liz
use zterm_lib::{models::ai::RiskLevel, services::ai_risk::classify_command};

#[test]
fn destructive_commands_are_high_or_critical_risk() {
    assert_eq!(classify_command("rm -rf /").risk_level, RiskLevel::Critical);
    assert_eq!(
        classify_command("rm -rf /tmp/demo").risk_level,
        RiskLevel::High
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
firewall-cmd --permanent --list-all
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

#[test]
fn long_inspection_scripts_ignore_dangerous_words_in_data_and_comments() {
    let script = r#"
# Do not run reboot or rm -rf / during inventory
printf '%s\n' '== shutdown / reboot / mkfs / docker rm =='
grep -E 'systemctl stop|rm -rf /|userdel|ufw allow' /var/log/audit.log
ps -ef | grep '[s]hutdown'
systemctl status reboot.target --no-pager
cat /etc/cron.d/reboot-check
echo 'firewall-cmd --add-port=22/tcp; iptables -F'
"#;
    assert_eq!(
        classify_command(&script.repeat(20)).risk_level,
        RiskLevel::Medium
    );
}

#[test]
fn real_mutations_inside_compound_and_wrapped_commands_still_require_approval() {
    for command in [
        "printf 'inspection'; /usr/bin/systemctl stop nginx",
        "true && sudo -u root /sbin/reboot",
        "if true; then rm --recursive /tmp/demo; fi",
        "env LANG=C sh -lc 'service nginx restart'",
        "bash -c 'echo ok; iptables -F'",
        "echo \"$(systemctl stop nginx)\"",
        "echo `reboot`",
        "echo \"$(echo \"$(reboot)\")\"",
        "eval 'systemctl stop nginx'",
        "sudo rm -fr /tmp/demo",
        "find /tmp/demo -type f -exec rm -rf '{}' \\;",
        "printf nginx | xargs -r systemctl stop",
        "xargs -I '{}' reboot",
        "xargs -n 1 systemctl stop nginx",
        "timeout 5 reboot",
        "> /tmp/out reboot",
        ">/tmp/out systemctl stop nginx",
        "python3 -c 'import os; os.system(\"reboot\")'",
    ] {
        assert_eq!(
            classify_command(command).risk_level,
            RiskLevel::High,
            "{command}"
        );
    }
    assert_eq!(
        classify_command("echo ok; sudo rm -rf /").risk_level,
        RiskLevel::Critical
    );
}

#[test]
fn quoted_delimiters_and_command_substitution_literals_remain_data() {
    for command in [
        "echo '$(reboot)'",
        "printf '%s' 'hello; reboot'",
        "grep 'mkfs' /tmp/report",
        "echo docker rmi shutdown",
        "command -v reboot",
        "bash -lc 'printf reboot'",
        "docker inspect --format rm container",
        "docker compose ps down",
        "systemctl show stop -p ActiveState",
        "kubectl get pods delete",
    ] {
        assert_eq!(
            classify_command(command).risk_level,
            RiskLevel::Medium,
            "{command}"
        );
    }
}
