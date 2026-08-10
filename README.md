# Sentinel: AWS Website Health Monitoring Platform

Serverless, multi-region website health monitoring platform on AWS. Built with CDK, Lambda, CloudWatch, SNS, and DynamoDB to track availability and latency, alert on failures, and log incidents automatically.

## Project Overview

Sentinel is a serverless monitoring system that periodically checks a configurable list of public websites, records their availability and latency to Amazon CloudWatch, visualizes this data on a live dashboard, and automatically raises alarms and logs incidents when a website's health drops below an acceptable threshold. The entire system is deployed and managed as Infrastructure-as-Code using the AWS Cloud Development Kit (CDK).

This project is being built as the NIT6150 Advanced Project at Victoria University.

## Team

- **Tenzing Tsering Lama** — Team Lead / Lead Developer
- **Samrat Neupane** — Research and Testing
- **Md. Malik** — Research and Testing

## Architecture

Sentinel is deployed as a single CDK stack, instantiated independently per AWS Region. Each regional instance creates its own fully independent set of resources (Lambda, S3, EventBridge, CloudWatch, SNS, DynamoDB) with no cross-region dependencies, so monitoring can continue uninterrupted in one region even if another becomes unavailable.

![Architecture of the Project](architecture.png)
<img width="768" height="1363" alt="architecture workflow" src="https://github.com/user-attachments/assets/c7dd6c90-7fab-49ca-84a6-326367d3c9ba" />

```
S3 (site list) → Lambda (canary/crawler) → CloudWatch (metrics)
                                                  ├── CloudWatch Dashboard
                                                  └── CloudWatch Alarms → SNS (notify)
                                                                       └── DynamoDB (log)
```

Each regional stack contains:

- **AWS Lambda** — website availability and latency checks
- **Amazon S3** — monitored-site configuration (`sites.json`)
- **Amazon EventBridge** — scheduled monitoring trigger *(planned — Phase 2)*
- **Amazon CloudWatch** — metrics, dashboards, and alarms *(metrics: Phase 2; alarms/dashboard: Phase 2–3)*
- **Amazon SNS** — alert notifications *(planned — Phase 3)*
- **Amazon DynamoDB** — incident records *(planned — Phase 3)*

## AWS Regions

| Region | Location | Status |
|---|---|---|
| `ap-southeast-2` | Sydney | Primary deployment region |
| *TBD* | *TBD (candidate: Singapore, `ap-southeast-1`)* | Second region, to be finalised during multi-region deployment (Phase 2) |

The same CDK stack definition is deployed to each region independently — regional resources are intentionally isolated so monitoring can continue from one region if another becomes unavailable.

## Project Status

🚧 **In progress** — currently in Phase 2 (crawler and S3 site configuration). See the project proposal and System Analysis and Design Report in `docs/` for the full phased plan.

| Feature | Status |
|---|---|
| Single-site health check (canary) | ✅ Implemented |
| Multi-site crawler (S3-configured) | ✅ Implemented |
| Scheduled execution (EventBridge) | ⬜ Not yet implemented |
| CloudWatch metric publishing | ⬜ Not yet implemented |
| CloudWatch Dashboard | ⬜ Not yet implemented |
| Multi-region deployment | ⬜ Not yet implemented |
| CloudWatch Alarms | ⬜ Not yet implemented |
| SNS notifications | ⬜ Not yet implemented |
| DynamoDB incident logging | ⬜ Not yet implemented |

## Features

### Website monitoring

The crawler Lambda reads the monitored-site list from S3 (`config/sites.json`). For each configured website, it records:

- Availability (up/down)
- HTTP status code
- Response latency (milliseconds)
- Error information when a request fails or times out

### CloudWatch metrics *(planned)*

Custom metrics will be published under the namespace `Sentinel/Monitoring`:

- Availability
- Latency

Metrics will use the website name as a dimension (e.g. `Site = example-site-01`).

### CloudWatch dashboards *(planned)*

Each regional stack will create a regional CloudWatch Dashboard including:

- Website availability
- Website latency
- Lambda invocations, errors, and duration

Dashboard names will follow the pattern `Sentinel-<region>`, e.g. `Sentinel-ap-southeast-2`.

### CloudWatch alarms *(planned)*

Two alarms are planned for Phase 3:

- **Availability alarm** — enters the alarm state when a site's availability falls below the expected value
- **Latency alarm** — triggers when response latency exceeds the configured threshold

Alarm notifications will be connected to an SNS topic.

### DynamoDB incident records *(planned)*

Monitoring incidents will be stored in a regional DynamoDB table, with each record containing:

- Incident ID
- Website name and URL
- Metric type, measured value, and threshold
- Timestamp and alarm state

Each AWS region will have its own incident table.

## Tech Stack

- **AWS CDK** (TypeScript) — Infrastructure as Code
- **AWS Lambda** — serverless compute for the canary/crawler
- **Amazon S3** — monitored-site configuration storage
- **Amazon CloudWatch** — metrics, dashboards, alarms
- **Amazon EventBridge** — scheduled execution
- **Amazon SNS** — alarm notifications
- **Amazon DynamoDB** — incident logging

## Repository Structure

```
sentinel-aws-monitor/
├── bin/                              # CDK app entry point
├── cdk.out/                          # Synthesized CloudFormation templates (generated, git-ignored)
├── config/
│   └── sites.json                    # Monitored-site configuration
├── docs/
│   └── NIT6150_Project_Proposal_Final.docx
├── infra/                            # CDK stack definitions
├── lambda/
│   ├── canary.ts                     # Phase 1: single-site health check
│   ├── crawler.ts                    # Phase 2: multi-site crawler (reads config/sites.json)
│   └── site-config.ts                # Shared types for site configuration
├── node_modules/                     # Installed dependencies (git-ignored)
├── test/                             # Unit tests
├── .gitignore
├── .npmignore
├── cdk.json                          # CDK app configuration
├── jest.config.js                    # Test runner configuration
├── out-crawler.json                  # Sample crawler invoke output
├── package.json
├── package-lock.json
├── README.md
└── tsconfig.json
```
## Prerequisites

- Node.js (LTS)
- AWS CLI, configured with an IAM user (`aws configure`)
- AWS CDK CLI (`npm install -g aws-cdk`)
- An AWS account with permissions for Lambda, S3, CloudWatch, SNS, DynamoDB, EventBridge, and IAM

## Setup

```bash
# Clone the repository
git clone https://github.com/TenzingT-Lama2001/sentinel-aws-monitor.git
cd sentinel-aws-monitor/infra

# Install dependencies
npm install

# Bootstrap CDK (one-time per AWS account/region)
cdk bootstrap

# Synthesize the CloudFormation template (sanity check)
cdk synth

# Deploy the stack
cdk deploy
```

## License

This project is submitted as coursework for NIT6150 Advanced Project, Victoria University.