"""A runner a test team names in its roster's supervisor block."""
from agyteam.runner import Runner


class TeamRunner(Runner):
    label = "team-runner"

    def wake(self, agent, message):
        return "ok"
