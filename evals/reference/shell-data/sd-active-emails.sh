jq '[.users[] | select(.active) | .profile.email | ascii_downcase] | sort' /workspace/users.json > /workspace/active_emails.json
