import React, { useEffect, useState } from 'react'
import { Layout, Input, Button, Table, Modal, Form } from 'antd'
import axios from 'axios'

const { Header, Content, Footer } = Layout

export default function App() {
  const [todos, setTodos] = useState([])
  const [searchKey, setSearchKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [form] = Form.useForm()

  const fetchTodos = async () => {
    const res = await axios.get('/api/v1/todoList', {
      params: {
        searchKey,
        page: 1,
        pageSize: 10
      }
    })
    setTodos(res.data.data)
  }

  useEffect(() => {
    fetchTodos()
  }, [])

  const createTodo = async (values: any) => {
    await axios.post('/api/v1/createTodo', values)
    setVisible(false)
    form.resetFields()
    fetchTodos()
  }

  const completeTodo = async (id: string) => {
    await axios.post('/api/v1/completeTodo', { id })
    fetchTodos()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: 'Title', dataIndex: 'title' },
    {
      title: 'Action',
      render: (_: any, record: any) => (
        <Button onClick={() => completeTodo(record.id)}>Complete</Button>
      )
    }
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ textAlign: 'center', color: '#fff' }}>
        📒 DEMO TODO MANAGE
      </Header>

      <Content style={{ padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <Input
              placeholder="Search..."
              value={searchKey}
              onChange={e => setSearchKey(e.target.value)}
              style={{ width: 200, marginRight: 8 }}
            />
            <Button onClick={fetchTodos}>Search</Button>
          </div>

          <Button type="primary" onClick={() => setVisible(true)}>
            Add Todo
          </Button>
        </div>

        <Table rowKey="id" dataSource={todos} columns={columns} />

        <Modal
          title="Create Todo"
          open={visible}
          onCancel={() => setVisible(false)}
          onOk={() => form.submit()}
        >
          <Form form={form} onFinish={createTodo}>
            <Form.Item name="title" required>
              <Input placeholder="Todo title" />
            </Form.Item>
          </Form>
        </Modal>
      </Content>

      <Footer style={{ textAlign: 'center' }}>
        This is a footer
      </Footer>
    </Layout>
  )
}