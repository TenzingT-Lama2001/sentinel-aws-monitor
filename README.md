# Sentinel: AWS Website Health Monitoring Platform

Serverless, multi-region website health monitoring platform on AWS. Built with CDK, Lambda, CloudWatch, SNS, and DynamoDB to track availability and latency, alert on failures, and log incidents automatically.

## Project Overview

Sentinel is a serverless monitoring system that periodically checks a configurable list of public websites, records their availability and latency to Amazon CloudWatch, visualizes this data on a live dashboard, and automatically raises alarms and logs incidents when a website's health drops below an acceptable threshold. The entire system is deployed and managed as Infrastructure-as-Code using the AWS Cloud Development Kit (CDK).

This project is being built as the NIT6150 Advanced Project at Victoria University.

## Team Members

- **Tenzing Tsering Lama**
- **Samrat Neupane**
- **Md. Malik**

Sentinel is deployed independently in two AWS regions:

ap-southeast-2 — Sydney
ap-southeast-1 — Melbourne [ Not decided yet . We will be deciding the region once we integrate the project]
Each regional stack contains:

AWS Lambda — website monitoring
Amazon S3 — website configuration
Amazon EventBridge — scheduled monitoring
Amazon CloudWatch — metrics, dashboards and alarms
Amazon SNS — alert notifications
Amazon DynamoDB — incident records


##Architecture of the Project

###Architecture workflow:

![Architecture of the Project](architecture.png)
<img width="768" height="1363" alt="architecture workflow" src="https://github.com/user-attachments/assets/c7dd6c90-7fab-49ca-84a6-326367d3c9ba" />
## Multi-region deployment

Sentinel uses a single CDK stack definition that is instantiated once per target region. Each instantiation creates its own fully independent set of resources — Lambda, S3, EventBridge, CloudWatch, SNS, and DynamoDB — with no cross-region dependencies. This means monitoring can continue uninterrupted from one region even if the other becomes unavailable.

## Features

### Website monitoring

The Lambda function reads website configuration from:

text
config/sites.json


For each configured website, Lambda records:

* Availability
* HTTP status code
* Response latency
* Error information when a request fails

## CloudWatch metrics

Custom metrics are published under the namespace:

text
Sentinel/Monitoring


The application publishes:

* Availability
* Latency




## CloudWatch dashboards

Each regional stack creates a regional CloudWatch dashboard. The dashboard includes:

* Website availability
* Website latency
* Lambda invocations
* Lambda errors
* Lambda duration

Dashboard names follow the regional pattern:

text
Sentinel-ap-southeast-2
Sentinel-ap-southeast-1


## CloudWatch alarms

We will be configuring two monitoring alarms for now.

### Availability alarm

Enters the alarm state when availability falls below the expected value.

### Latency alarm

Monitors website response latency and triggers when latency exceeds the configured threshold.

Alarm notifications will be connected to an SNS topic.

## DynamoDB incident records

Monitoring incidents are stored in a regional DynamoDB table. Incident records contain:

* Incident ID
* Website name
* Website URL
* Timestamp

Each AWS region has its own incident table.

## AWS Regions

| AWS Region       | Location  | Stack                         |
| ---------------- | --------- | ----------------------------- |
| ap-southeast-2 | Sydney    | SentinelAwsMonitorSydney    |
| ap-southeast-1 | Melbourne | SentinelAwsMonitorMelbourne |




Region	Location	Stack
ap-southeast-2	Sydney	SentinelAwsMonitorSydney
ap-southeast-1	Singapore	SentinelAwsMonitorMelbourne
The regional resources are intentionally independent so that monitoring can continue from another AWS region.

