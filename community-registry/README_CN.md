# AI-Tools 社区注册表

欢迎来到 AI-Tools 社区注册表！本目录包含社区贡献的 MCP Server 和 AI Agent Skills 配置。

## 如何贡献

### 贡献 MCP Server

1. **使用官方工具生成 server.json**：
   ```bash
   npx mcp-publisher init
   ```

2. **复制并自定义模板**：
   ```bash
   cp _template.json servers/your-server-name.json
   ```

3. **填写配置信息**：
   - `name`: 唯一标识符（格式：`io.github.username/project-name`）
   - `displayName`: 显示名称
   - `description`: 功能描述
   - `packages`: 安装配置
   - `environmentVariables`: 环境变量配置

4. **提交 Pull Request** 到本仓库。

### 贡献 Skill

1. **复制模板**：
   ```bash
   cp _template.json skills/your-skill-name.json
   ```

2. **填写配置信息**：
   - `name`: Skill 标识符（支持字母数字、连字符、下划线）
   - `description`: 使用场景和方法说明
   - `repoUrl`: GitHub 仓库地址
   - `skillPath`: SKILL.md 在仓库中的路径
   - `category`: 分类（可选：Coding、Testing、DevOps、Data & Analytics、Security、Content & Writing、Productivity、Design）

3. **提交 Pull Request** 到本仓库。

## Schema 校验

所有提交都会根据以下 Schema 自动校验：
- **Servers**: `schemas/server.schema.json`
- **Skills**: `schemas/skill.schema.json`

如果 JSON 格式不符合 Schema 要求，PR 将无法通过。

## 贡献指南

1. **质量要求**：确保贡献内容有完善的文档和持续维护
2. **安全要求**：禁止包含任何密钥或敏感信息
3. **准确性**：提交前请测试配置的正确性
4. **命名规范**：使用清晰、描述性的名称
5. **描述完整**：为用户编写有帮助的描述

## 需要帮助？

- 查阅 [MCP 官方文档](https://modelcontextprotocol.io/)
- 参考现有的配置示例
- 如有疑问请提交 Issue

感谢你为 AI-Tools 做出贡献！🎉
