from __future__ import annotations

import litellm

from minisweagent.models.litellm_model import LitellmModel
from minisweagent.models.utils.actions_toolcall import BASH_TOOL


class BedrockLitellmModel(LitellmModel):
    """mini-SWE-agent adapter for Bedrock Anthropic tool calling.

    Bedrock rejects mini-SWE-agent's default request payload for Anthropic tool
    calls unless `tool_choice` is explicitly set to the string `"auto"`.
    """

    def _query(self, messages: list[dict[str, str]], **kwargs):
        return litellm.completion(
            model=self.config.model_name,
            messages=messages,
            tools=[BASH_TOOL],
            tool_choice="auto",
            **(self.config.model_kwargs | kwargs),
        )
