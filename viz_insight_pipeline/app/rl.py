import json
import os
import logging
from dataclasses import dataclass, asdict
from typing import Dict, List

import numpy as np


logger = logging.getLogger(__name__)


@dataclass
class Arm:
    arm_id: str
    stage: str  # e.g. "unified"
    model_name: str
    notes: str = ""
    temperature: float = 0.1


@dataclass
class ArmStats:
    alpha: float = 1.0  # successes
    beta: float = 1.0   # failures
    pulls: int = 0


class ThompsonBandit:
    def __init__(self, state_path: str):
        self.state_path = state_path
        self._stats: Dict[str, ArmStats] = {}
        self._load()

    def _load(self):
        if os.path.exists(self.state_path):
            try:
                with open(self.state_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                for arm_id, stat_obj in data.get("arms", {}).items():
                    self._stats[arm_id] = ArmStats(**stat_obj)
                logger.info(
                    "bandit.state_loaded path=%s arms=%d",
                    self.state_path,
                    len(self._stats),
                )
            except Exception:
                self._stats = {}
                logger.warning(
                    "bandit.state_load_failed path=%s",
                    self.state_path,
                    exc_info=True,
                )
        else:
            logger.info("bandit.state_missing path=%s", self.state_path)

    def _save(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        data = {"arms": {k: asdict(v) for k, v in self._stats.items()}}
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        logger.debug(
            "bandit.state_saved path=%s arms=%d",
            self.state_path,
            len(self._stats),
        )

    def get_stats_snapshot(self) -> Dict[str, Dict[str, float]]:
        return {k: asdict(v) for k, v in self._stats.items()}

    def get_arm_stats(self, arm_id: str):
        s = self._stats.get(arm_id)
        return asdict(s) if s else None

    def ensure_arms(self, arms: List[Arm]):
        added = 0
        for arm in arms:
            if arm.arm_id not in self._stats:
                self._stats[arm.arm_id] = ArmStats()
                added += 1
        self._save()
        if added:
            logger.info(
                "bandit.ensure_arms_added path=%s added=%d total=%d",
                self.state_path,
                added,
                len(self._stats),
            )

    def choose(self, stage: str, arms: List[Arm]) -> Arm:
        candidates = [a for a in arms if a.stage == stage]
        if not candidates:
            raise ValueError(f"No arms found for stage {stage}")

        samples = []
        sample_map = {}
        for arm in candidates:
            stats = self._stats.get(arm.arm_id) or ArmStats()
            sample = np.random.beta(stats.alpha, stats.beta)
            samples.append(sample)
            sample_map[arm.arm_id] = float(sample)

        best_idx = int(np.argmax(samples))
        chosen = candidates[best_idx]
        chosen_stats = self._stats.get(chosen.arm_id)
        logger.info(
            "bandit.choose stage=%s arm_id=%s alpha=%.1f beta=%.1f pulls=%d samples=%s",
            stage,
            chosen.arm_id,
            float(chosen_stats.alpha) if chosen_stats else 1.0,
            float(chosen_stats.beta) if chosen_stats else 1.0,
            int(chosen_stats.pulls) if chosen_stats else 0,
            json.dumps(sample_map, ensure_ascii=False),
        )
        return chosen

    def update(self, arm_id: str, reward: int):
        if arm_id not in self._stats:
            logger.warning("bandit.update_unknown_arm arm_id=%s reward=%s", arm_id, reward)
            return None

        stats = self._stats[arm_id]
        before = asdict(stats)
        stats.pulls += 1
        if reward == 1:
            stats.alpha += 1
        else:
            stats.beta += 1

        self._save()
        after = asdict(stats)
        logger.info(
            "bandit.update arm_id=%s reward=%d before=%s after=%s",
            arm_id,
            int(reward),
            json.dumps(before, ensure_ascii=False),
            json.dumps(after, ensure_ascii=False),
        )
        return after
